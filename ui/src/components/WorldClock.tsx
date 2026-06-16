import { useEffect, useState } from 'react';
import { api } from '../api';

interface ClockCity { label: string; offset: number; dst?: string; now: string }
interface ClockData { cities: ClockCity[]; catalog: string[] }

/** Manage the cities ForceAI is time-aware of. The bot receives these exact, pre-computed times on
 *  every request, so it always knows the real date/time — no guessing, no timezone math on its end. */
export function WorldClock() {
  const [data, setData] = useState<ClockData | null>(null);

  const load = () => api<ClockData>('/api/clock').then(setData).catch(() => undefined);
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000); // keep the previewed times ticking
    return () => clearInterval(t);
  }, []);

  if (!data) return null;

  const save = async (labels: string[]) => {
    const next = await api<ClockData>('/api/clock', { method: 'POST', body: JSON.stringify({ labels }) });
    setData(next);
  };
  const remove = (label: string) => save(data.cities.filter(c => c.label !== label).map(c => c.label));
  const add = (label: string) => {
    if (!label || data.cities.some(c => c.label === label)) return;
    save([...data.cities.map(c => c.label), label]);
  };

  const available = data.catalog.filter(l => !data.cities.some(c => c.label === l));

  return (
    <>
      <h3 style={{ margin: '18px 0 4px' }}>World clock</h3>
      <p className="hint" style={{ margin: '0 0 10px' }}>
        The cities ForceAI knows the current time in. It receives these exact times on every request, so it
        always knows the real date &amp; time — yours plus wherever your friends are. For any city not listed,
        it estimates from the nearest one here.
      </p>

      <div className="clock-cities">
        {data.cities.map(c => (
          <div key={c.label} className="clock-city">
            <div className="clock-city-main">
              <span className="clock-label">{c.label}</span>
              <span className="clock-now">{c.now}</span>
            </div>
            <button className="clock-x" title={`Remove ${c.label}`} onClick={() => remove(c.label)}>✕</button>
          </div>
        ))}
        {data.cities.length === 0 && <div className="hint">No cities yet — add one below.</div>}
      </div>

      {available.length > 0 && (
        <div className="settings-row" style={{ marginTop: 10 }}>
          <div>
            <label>Add a city</label>
            <div className="hint">Where you live, or where your friends are.</div>
          </div>
          <select value="" onChange={e => add(e.target.value)}>
            <option value="">+ add city…</option>
            {available.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
      )}
    </>
  );
}
