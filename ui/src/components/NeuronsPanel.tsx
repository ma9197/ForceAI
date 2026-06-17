import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { api, type NeuronNode, type NeuronsResponse, type NeuronType } from '../api';
import { buildEdges, NEURON_COLORS, NEURON_TYPE_LABEL, NEURON_TYPE_SINGULAR, type NeuronLink } from './neuronsGraph';

const TYPE_ORDER: NeuronType[] = ['fact', 'voice', 'report', 'stat', 'observation', 'lesson', 'principle', 'sticker', 'summary'];
const MAX_RENDER = 4000; // hard cap; above this we keep the newest N

/** The living neuron-web: every saved item is a node, drifting on a black canvas, interconnected by
 *  a thin web with white pulses travelling along it. Fullscreen overlay. */
export function NeuronsPanel({ version, onClose }: { version: number; onClose: () => void }) {
  const graphRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const masterRef = useRef<NeuronNode[]>([]); // stable node objects (force-graph mutates x/y on them)
  const breatheReady = useRef(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [dims, setDims] = useState({ w: 800, h: 600 });
  const [rev, setRev] = useState(0);            // bumps when master changes (after fetch/merge)
  const [cutoff, setCutoff] = useState<number>(0);
  const [maxT, setMaxT] = useState(0);
  const [minT, setMinT] = useState(0);
  const [selected, setSelected] = useState<NeuronNode | null>(null);
  const [playing, setPlaying] = useState(false);

  // ---- fetch (initial + on live `version` bump) ----
  const load = useCallback(async (merge: boolean) => {
    try {
      const res = await api<NeuronsResponse>('/api/neurons');
      let nodes = res.nodes ?? [];
      if (nodes.length > MAX_RENDER) nodes = [...nodes].sort((a, b) => a.t - b.t).slice(-MAX_RENDER);
      if (merge && masterRef.current.length) {
        const byId = new Map(masterRef.current.map(n => [n.id, n]));
        for (const n of nodes) if (!byId.has(n.id)) { masterRef.current.push(n); byId.set(n.id, n); } // append only new (keep positions)
      } else {
        masterRef.current = nodes;
      }
      const ts = masterRef.current.map(n => n.t).filter(Boolean);
      const lo = ts.length ? Math.min(...ts) : 0;
      const hi = ts.length ? Math.max(...ts) : 0;
      setMinT(lo); setMaxT(hi);
      setCutoff(c => (c === 0 || !merge ? hi : c));
      setRev(r => r + 1);
      setError(false);
    } catch { setError(true); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(false); }, [load]);
  // live: a debounced refetch when the bot learns something new
  useEffect(() => {
    if (version === 0) return;
    const id = setTimeout(() => void load(true), 800);
    return () => clearTimeout(id);
  }, [version, load]);

  // ---- responsive canvas size (re-run once the canvas actually mounts, i.e. after loading) ----
  useEffect(() => {
    const el = wrapRef.current; if (!el) return; // null while the loading/empty screen is shown
    const apply = () => setDims({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    apply();
    return () => ro.disconnect();
  }, [loading, error]);

  // ---- full graph, built once per fetch (stable reference → no re-simulation on timeline scrub).
  // The timeline reveals/hides nodes via nodeVisibility/linkVisibility, so positions stay put. ----
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fullGraph = useMemo(() => ({ nodes: masterRef.current, links: buildEdges(masterRef.current) as NeuronLink[] }), [rev]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tById = useMemo(() => { const m = new Map<string, number>(); for (const n of masterRef.current) m.set(n.id, n.t); return m; }, [rev]);
  const cut = cutoff || maxT || Number.MAX_SAFE_INTEGER;
  const endpointT = (e: any) => (typeof e === 'object' && e ? (e.t ?? 0) : (tById.get(e) ?? 0));

  const visibleNodes = useMemo(() => fullGraph.nodes.filter(n => n.t <= cut), [fullGraph, cut]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const visibleLinks = useMemo(() => fullGraph.links.filter(l => endpointT((l as any).source) <= cut && endpointT((l as any).target) <= cut).length, [fullGraph, cut]);
  const typeCounts = useMemo(() => {
    const c: Partial<Record<NeuronType, number>> = {};
    for (const n of visibleNodes) c[n.type] = (c[n.type] ?? 0) + 1;
    return c;
  }, [visibleNodes]);

  // ---- "alive" forces: a stable, well-spread web that shimmers in place forever ----
  // We disable d3's alpha cooldown (d3AlphaDecay={0} below) so the real charge/link forces stay at
  // full strength permanently — they define and *hold* the spread. A strong charge balanced against
  // a very weak center-pull gives a fixed equilibrium size (no roaming, no slow collapse). On top of
  // that, a tiny per-tick velocity jitter keeps everything gently breathing rather than frozen.
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || breatheReady.current || fullGraph.nodes.length === 0) return;
    breatheReady.current = true;
    try {
      fg.d3Force('charge')?.strength?.(-34);   // open, spread-out web
      fg.d3Force('link')?.distance?.(30);
      let simNodes: NeuronNode[] = [];
      const breathe = () => {
        for (const n of simNodes) {
          // a faint shimmer + a *very* weak pull toward origin: the full-strength charge balances
          // this pull to a fixed, stable size (no collapse, no fly-away). Keep the jitter tiny so the
          // web only slowly breathes/drifts in place rather than visibly spinning off-frame.
          n.vx = (n.vx ?? 0) + (Math.random() - 0.5) * 0.006 - (n.x ?? 0) * 0.00022;
          n.vy = (n.vy ?? 0) + (Math.random() - 0.5) * 0.006 - (n.y ?? 0) * 0.00022;
        }
      };
      breathe.initialize = (ns: NeuronNode[]) => { simNodes = ns; };
      fg.d3Force('breathe', breathe);
    } catch { /* lib internals changed — ignore */ }
    // fit once the spread settles, then pull back to ~80% so the gentle drift has margin to roam
    const id = setTimeout(() => {
      fg.zoomToFit?.(700, 60);
      setTimeout(() => { try { fg.zoom?.(fg.zoom() * 0.8, 500); } catch { /* */ } }, 800);
    }, 900);
    return () => clearTimeout(id);
  }, [fullGraph.nodes.length]);

  // ---- pause the animation loop while the tab/window is hidden (big CPU saver) ----
  useEffect(() => {
    const onVis = () => { const fg = graphRef.current; if (!fg) return; document.hidden ? fg.pauseAnimation?.() : fg.resumeAnimation?.(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); graphRef.current?.pauseAnimation?.(); };
  }, []);

  // ---- timeline play ----
  useEffect(() => {
    if (!playing) return;
    if (cutoff >= maxT) { setPlaying(false); return; }
    const span = Math.max(1, maxT - minT);
    const id = setInterval(() => setCutoff(c => Math.min(maxT, c + span / 120)), 60);
    return () => clearInterval(id);
  }, [playing, maxT, minT, cutoff]);

  const zoomBy = (f: number) => { const fg = graphRef.current; if (fg) fg.zoom(fg.zoom() * f, 250); };

  if (loading) return <div className="neurons-overlay"><Center>🧠 Waking up the brain…</Center><Exit onClose={onClose} /></div>;
  if (error) return <div className="neurons-overlay"><Center>Couldn't load the brain. <button onClick={() => { setLoading(true); void load(false); }}>Retry</button></Center><Exit onClose={onClose} /></div>;
  if (masterRef.current.length === 0) return <div className="neurons-overlay"><Center>No neurons yet — they appear as ForceAI learns.</Center><Exit onClose={onClose} /></div>;

  return (
    <div className="neurons-overlay">
      <div className="neurons-canvas" ref={wrapRef}>
        <ForceGraph2D
          ref={graphRef}
          width={dims.w}
          height={dims.h}
          graphData={fullGraph}
          backgroundColor="rgba(0,0,0,0)"
          nodeId="id"
          nodeRelSize={3}
          nodeVisibility={(n: any) => (n.t ?? 0) <= cut}
          linkVisibility={(l: any) => endpointT(l.source) <= cut && endpointT(l.target) <= cut}
          nodeColor={(n: any) => NEURON_COLORS[(n as NeuronNode).type] ?? '#9aa'}
          nodeLabel={(n: any) => `<div class="neurons-tip">${escapeHtml((n as NeuronNode).label)}</div>`}
          linkColor={() => 'rgba(255,255,255,0.10)'}
          linkWidth={0.5}
          linkDirectionalParticles={(l: any) => (l as NeuronLink).__p ?? 0}
          linkDirectionalParticleSpeed={0.006}
          linkDirectionalParticleWidth={1.8}
          linkDirectionalParticleColor={() => 'rgba(255,255,255,0.92)'}
          cooldownTime={Infinity}
          d3AlphaDecay={0}
          d3VelocityDecay={0.75}
          enableNodeDrag={false}
          onNodeClick={(n: any) => setSelected(n as NeuronNode)}
          onBackgroundClick={() => setSelected(null)}
        />
      </div>

      {/* HUD: counts */}
      <div className="neurons-hud">
        <div className="neurons-title">🧠 ForceAI brain</div>
        <div className="neurons-count">{visibleNodes.length.toLocaleString()} neurons · {visibleLinks.toLocaleString()} connections</div>
      </div>

      {/* legend */}
      <div className="neurons-legend">
        {TYPE_ORDER.filter(t => (typeCounts[t] ?? 0) > 0).map(t => (
          <div key={t} className="neurons-legend-row">
            <span className="neurons-dot" style={{ background: NEURON_COLORS[t] }} />
            {NEURON_TYPE_LABEL[t]} <span className="muted">{typeCounts[t]}</span>
          </div>
        ))}
      </div>

      {/* zoom + exit */}
      <div className="neurons-zoom">
        <button onClick={() => zoomBy(1.4)}>＋</button>
        <button onClick={() => zoomBy(1 / 1.4)}>－</button>
        <button onClick={() => graphRef.current?.zoomToFit?.(600, 50)} title="Fit">⤢</button>
      </div>
      <button className="neurons-exit" onClick={onClose}>✕ Exit</button>

      {/* detail card */}
      {selected && (
        <div className="neurons-detail">
          <div className="neurons-detail-head">
            <span className="neurons-dot" style={{ background: NEURON_COLORS[selected.type] }} />
            <b>{NEURON_TYPE_SINGULAR[selected.type]}</b>
            <span className="gclose" onClick={() => setSelected(null)} style={{ marginLeft: 'auto', cursor: 'pointer' }}>✕</span>
          </div>
          <p className="neurons-detail-text">{selected.text}</p>
          <div className="neurons-detail-meta muted">
            {selected.member && <span>👤 {selected.member}</span>}
            {selected.group && <span>· {selected.group}</span>}
            {selected.category && <span>· {selected.category}</span>}
            {selected.t > 0 && <span>· {new Date(selected.t).toLocaleString()}</span>}
          </div>
        </div>
      )}

      {/* timeline */}
      {maxT > minT && (
        <div className="neurons-timeline">
          <button onClick={() => { if (cutoff >= maxT) setCutoff(minT); setPlaying(p => !p); }}>{playing ? '⏸' : '▶'}</button>
          <input type="range" min={minT} max={maxT} value={cutoff || maxT} step={Math.max(1, (maxT - minT) / 1000)}
            onChange={e => { setPlaying(false); setCutoff(Number(e.target.value)); }} />
          <span className="neurons-time-label muted">{new Date(cutoff || maxT).toLocaleDateString()} · {visibleNodes.length}</span>
        </div>
      )}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="center-screen" style={{ color: 'var(--text)' }}>{children}</div>;
}
function Exit({ onClose }: { onClose: () => void }) {
  return <button className="neurons-exit" onClick={onClose}>✕ Exit</button>;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
