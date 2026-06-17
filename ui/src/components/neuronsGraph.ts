import type { NeuronNode, NeuronType } from '../api';

export interface NeuronLink { source: string; target: string; __p?: number }

// Distinct per-type colors (the "lobes" of the brain).
export const NEURON_COLORS: Record<NeuronType, string> = {
  fact: '#5b8cff',        // blue
  voice: '#25d366',       // green
  report: '#ffb454',      // amber
  stat: '#ff7e6b',        // coral
  observation: '#9ad36b', // lime
  lesson: '#d98cff',      // purple
  principle: '#f6c445',   // gold
  sticker: '#4fd1c5',     // teal
  summary: '#ff8fb1',     // pink
};
export const NEURON_TYPE_LABEL: Record<NeuronType, string> = {
  fact: 'Facts', voice: 'Voice', report: 'Bios', stat: 'Stats', observation: 'Observations',
  lesson: 'Influences', principle: 'Principles', sticker: 'Stickers', summary: 'Summaries',
};
// Singular form for the detail card header (English plurals aren't all "drop the s").
export const NEURON_TYPE_SINGULAR: Record<NeuronType, string> = {
  fact: 'Fact', voice: 'Voice', report: 'Bio', stat: 'Stat', observation: 'Observation',
  lesson: 'Influence', principle: 'Principle', sticker: 'Sticker', summary: 'Summary',
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Build a deterministic, sparse, pretty edge set. Real relationships are irrelevant — edges are
 * purely visual. Nodes cluster into per-type "lobes"; each lobe is a ring (so every node has ≥1
 * edge) plus a few seeded chords for organic mesh; lobe representatives chain together so the whole
 * thing is ONE connected brain. Deterministic (seeded by id) so the web is stable as nodes appear.
 */
export function buildEdges(nodes: NeuronNode[]): NeuronLink[] {
  if (nodes.length < 2) return [];
  const lobes = new Map<NeuronType, NeuronNode[]>();
  for (const n of nodes) {
    let arr = lobes.get(n.type);
    if (!arr) { arr = []; lobes.set(n.type, arr); }
    arr.push(n);
  }
  const seen = new Set<string>();
  const links: NeuronLink[] = [];
  const add = (a: string, b: string) => {
    if (a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source: a, target: b });
  };
  const reps: string[] = [];
  for (const arr of lobes.values()) {
    arr.sort((x, y) => x.t - y.t || (x.id < y.id ? -1 : 1));
    reps.push(arr[0].id);
    const L = arr.length;
    for (let i = 0; i < L; i++) {
      if (L > 1) add(arr[i].id, arr[(i + 1) % L].id);                 // ring → connectivity
      if (L > 4) {                                                    // chords → organic mesh
        const off = 2 + (hash(arr[i].id) % Math.max(1, Math.floor(L / 3)));
        add(arr[i].id, arr[(i + off) % L].id);
      }
    }
  }
  for (let i = 0; i < reps.length - 1; i++) add(reps[i], reps[i + 1]); // bridge lobes into one brain

  // Mark a bounded subset of links to carry a travelling "firing" particle — keep it ~constant
  // regardless of scale so it stays smooth at thousands of edges.
  const every = Math.max(1, Math.ceil(links.length / 400));
  links.forEach((l, i) => { l.__p = i % every === 0 ? 1 : 0; });
  return links;
}
