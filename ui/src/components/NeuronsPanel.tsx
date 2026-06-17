import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { api, type NeuronNode, type NeuronsResponse, type NeuronType } from '../api';
import { buildEdges, NEURON_COLORS, NEURON_TYPE_LABEL, NEURON_TYPE_SINGULAR, type NeuronLink } from './neuronsGraph';

const TYPE_ORDER: NeuronType[] = ['fact', 'voice', 'report', 'stat', 'observation', 'lesson', 'principle', 'sticker', 'summary'];
const MAX_RENDER = 4000; // hard cap; above this we keep the newest N

/** The living neuron-web: every saved item is a node, drifting on a black canvas, interconnected by
 *  a thin web with white pulses travelling along it. Fullscreen overlay. */
export function NeuronsPanel({ active, version, onClose }: { active: boolean; version: number; onClose: () => void }) {
  const graphRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const masterRef = useRef<NeuronNode[]>([]); // stable node objects (force-graph mutates x/y on them)
  const forcesReady = useRef(false);         // one-time force config applied
  const fetchedRef = useRef(false);          // initial /api/neurons fired exactly once (StrictMode-safe)
  const [docHidden, setDocHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  const shouldRun = active && !docHidden;    // single source of truth: run sim + measure only while visible

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

  // Fetch once, on first reveal — a user who never opens Neurons never pays the /api/neurons fetch
  // (nor parses the static-demo fixture). fetchedRef survives StrictMode mount→unmount→mount so it
  // fires exactly once.
  useEffect(() => {
    if (!active || fetchedRef.current) return;
    fetchedRef.current = true;
    void load(false);
  }, [active, load]);
  // live: a debounced refetch when the bot learns something new
  useEffect(() => {
    if (version === 0) return;
    const id = setTimeout(() => void load(true), 800);
    return () => clearTimeout(id);
  }, [version, load]);

  // ---- responsive canvas size + (re)framing. Only runs while visible (display:none reports 0x0). ----
  useEffect(() => {
    if (!shouldRun) return;                       // never measure while hidden — clientW/H read 0
    const el = wrapRef.current; if (!el) return;  // null while the loading/empty screen is shown
    let fitT: ReturnType<typeof setTimeout>;
    const apply = () => {
      if (!el.clientWidth || !el.clientHeight) return; // MANDATORY: a 0x0 reflow must never clobber dims
      setDims({ w: el.clientWidth, h: el.clientHeight });
      // Re-frame shortly after any size change. This also handles REVEAL (display:none→shown re-runs
      // this effect) and *recovers* from late reflows (web-font swaps, the analytics beacon on the
      // hosted demo, devtools) that can reset the canvas's zoom transform and leave it a tiny dot.
      clearTimeout(fitT);
      fitT = setTimeout(() => { try { graphRef.current?.zoomToFit?.(500, 80); } catch { /* */ } }, 400);
    };
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    apply();
    return () => { ro.disconnect(); clearTimeout(fitT); };
  }, [shouldRun, loading, error]);

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

  // ---- forces: spread out, settle into one organic blob, then come to rest (and be draggable) ----
  // UNcapped repulsion pushes nodes apart so they fill the void with room to breathe; the random link
  // mesh pulls connected nodes together; force-graph's default center force keeps the whole blob
  // framed (translation only — no squeeze). Alpha cools naturally (default d3AlphaDecay) so it SETTLES
  // and stops instead of shaking forever — dragging a node briefly reheats it, then it settles again.
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || forcesReady.current || fullGraph.nodes.length === 0) return;
    forcesReady.current = true;
    try {
      fg.d3Force('charge')?.strength?.(-55);            // strong repulsion → roomy, unpacked spread
      fg.d3Force('charge')?.distanceMax?.(Infinity);    // UNcap it (was 220) — the cap is what packed them
      fg.d3Force('link')?.distance?.(36);
    } catch { /* lib internals changed — ignore */ }
    // Frame the brain after it settles. A single fixed-delay fit is fragile (fires before it spreads),
    // so fit several times over the first few seconds; the last catches the settled layout. These are
    // one-shot — after settling there is no auto-fit, so dragging never yanks the camera.
    const fit = () => { const el = wrapRef.current; if (el?.clientWidth && el.clientHeight) { try { fg.zoomToFit?.(600, 80); } catch { /* */ } } };
    const timers = [setTimeout(fit, 800), setTimeout(fit, 2500), setTimeout(fit, 5500)];
    return () => timers.forEach(clearTimeout);
  }, [fullGraph.nodes.length]);

  // ---- track OS tab/window visibility into state so the pause controller re-evaluates on it ----
  useEffect(() => {
    const onVis = () => setDocHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // ---- SINGLE run/pause controller: run iff (active && !document.hidden). No second resumer can
  // race it. `rev` is in deps so it (re)applies once graphRef is populated after the first load. ----
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg) return;
    if (shouldRun) fg.resumeAnimation?.(); else fg.pauseAnimation?.();
  }, [shouldRun, rev]);

  // ---- on REVEAL (hidden→shown), refit against REAL post-display dimensions after a double rAF so
  // we never fit a stale 0x0; recovers the exact framing the user left. Keyed on shouldRun only, so
  // a live append (rev bump) never yanks the camera while you're inspecting. ----
  useEffect(() => {
    if (!shouldRun) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const fg = graphRef.current, el = wrapRef.current;
        if (fg && el?.clientWidth && el.clientHeight) {
          setDims({ w: el.clientWidth, h: el.clientHeight });
          try { fg.zoomToFit?.(400, 80); } catch { /* */ }
        }
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [shouldRun]);

  // ---- timeline play (frozen while hidden so you return to the exact cutoff you left) ----
  useEffect(() => {
    if (!playing || !shouldRun) return;
    if (cutoff >= maxT) { setPlaying(false); return; }
    const span = Math.max(1, maxT - minT);
    const id = setInterval(() => setCutoff(c => Math.min(maxT, c + span / 120)), 60);
    return () => clearInterval(id);
  }, [playing, maxT, minT, cutoff, shouldRun]);

  const zoomBy = (f: number) => { const fg = graphRef.current; if (fg) fg.zoom(fg.zoom() * f, 250); };

  // Lazy-mounted by App on first activation; thereafter stays mounted and hides via display:none
  // (removes it from layout + hit-testing, so the dashboard underneath stays fully clickable).
  const style: CSSProperties | undefined = active ? undefined : { display: 'none' };

  if (loading) return <div className="neurons-overlay" style={style}><Center>🧠 Waking up the brain…</Center><Exit onClose={onClose} /></div>;
  if (error) return <div className="neurons-overlay" style={style}><Center>Couldn't load the brain. <button onClick={() => { setLoading(true); void load(false); }}>Retry</button></Center><Exit onClose={onClose} /></div>;
  if (masterRef.current.length === 0) return <div className="neurons-overlay" style={style}><Center>No neurons yet — they appear as ForceAI learns.</Center><Exit onClose={onClose} /></div>;

  return (
    <div className="neurons-overlay" style={style}>
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
          linkDirectionalParticleOffset={(l: any) => (l as NeuronLink).__phase ?? 0}  // random start phase → desynced
          linkDirectionalParticleSpeed={0.006}
          linkDirectionalParticleWidth={1.8}
          linkDirectionalParticleColor={() => 'rgba(255,255,255,0.92)'}
          d3VelocityDecay={0.5}
          enableNodeDrag={true}
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
