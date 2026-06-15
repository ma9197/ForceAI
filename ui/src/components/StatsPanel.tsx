import type { GroupStatus } from '../api';

const GLOBAL_LABELS: Record<string, string> = {
  cost_today_usd_cents: 'Spent today (all groups)',
  cost_microusd: 'Total cost (all groups)',
  messages_read: 'Messages read (all)',
  messages_sent: 'Messages sent (all)',
  facts_learned: 'Facts learned (all)',
  voice_items_learned: 'Voice notes learned (all)',
  t1_calls: 'Gatekeeper calls (all)',
  t2_calls: 'Generation calls (all)',
  extract_calls: 'Extraction runs (all)',
  voice_calls: 'Voice-profiler runs (all)',
  input_tokens: 'Input tokens',
  output_tokens: 'Output tokens',
  cache_read_tokens: 'Cached tokens read',
};

function fmt(key: string, value: number): string {
  if (key === 'cost_microusd') return `$${(value / 1_000_000).toFixed(3)}`;
  if (key === 'cost_today_usd_cents') return `$${(value / 100).toFixed(2)}`;
  return value.toLocaleString();
}

export function StatsPanel({ group, globalStats }: { group: GroupStatus | null; globalStats: Record<string, number> }) {
  const globalKeys = Object.keys(GLOBAL_LABELS).filter(k => globalStats[k] !== undefined);

  return (
    <div>
      {group && (
        <>
          <h3 style={{ margin: '0 0 8px' }}>This group — {group.name ?? group.jid.split('@')[0]}</h3>
          <div className="stat-grid">
            <div className="stat"><div className="v">{fmt('cost_microusd', group.stats.cost_microusd)}</div><div className="k">Cost (this group)</div></div>
            <div className="stat"><div className="v">{group.stats.messages_read.toLocaleString()}</div><div className="k">Messages read</div></div>
            <div className="stat"><div className="v">{group.stats.messages_sent.toLocaleString()}</div><div className="k">Messages sent</div></div>
            <div className="stat"><div className="v">{group.stats.facts_learned.toLocaleString()}</div><div className="k">Facts learned</div></div>
            <div className="stat"><div className="v">{group.stats.t1_calls.toLocaleString()}</div><div className="k">Gatekeeper calls</div></div>
            <div className="stat"><div className="v">{group.stats.t2_calls.toLocaleString()}</div><div className="k">Generation calls</div></div>
          </div>
        </>
      )}

      <h3 style={{ margin: '18px 0 8px' }}>Global — all groups</h3>
      <div className="stat-grid">
        {globalKeys.map(k => (
          <div key={k} className="stat">
            <div className="v">{fmt(k, globalStats[k])}</div>
            <div className="k">{GLOBAL_LABELS[k]}</div>
          </div>
        ))}
        {globalKeys.length === 0 && <p className="muted">No stats yet.</p>}
      </div>
    </div>
  );
}
