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

const CHORDS_PER_NODE = 3; // long-range links per node → one filled small-world mesh (incl. ~diametric)
const PARTICLE_CAP = 400;  // keep travelling "firing" pulses ~constant regardless of scale

/**
 * Deterministic, COLOR-BLIND edge web that holds every node in ONE cohesive blob.
 *
 * Edges are purely decorative (which node links to which is irrelevant) — they only feed d3's
 * 'link' spring. The OLD build bucketed by TYPE (dense intra-type rings + a sparse rep chain), so
 * the link force balled up each type while charge shoved the balls apart → ~10 separate balls on
 * long strings. Here the topology is TYPE-AGNOSTIC: every node links to arbitrary-type neighbours,
 * so no per-colour spring subset exists for the layout to contract into its own ball. The whole set
 * pulls toward one centroid (charge just sets the radius) → a single rainbow blob, held forever
 * under d3AlphaDecay=0.
 *
 * Geometry: a hash-shuffled backbone RING guarantees a single connected component (min degree 2, no
 * orphans). On top, each node gets K hash-seeded CHORDS whose targets span the full shuffled range
 * (including ~N/2 diametric jumps), folding the 1-D ring into a 2-D small-world mesh (avg degree ~4)
 * whose minimal-energy embedding under charge+link is a FILLED disc — not a hollow ring, not a line.
 * Deterministic (seeded by node id) so the web is byte-identical across reloads. O(N log N).
 */
export function buildEdges(nodes: NeuronNode[]): NeuronLink[] {
  const N = nodes.length;
  if (N < 2) return [];

  // Stable HASH order — NOT id order. Sort a COPY (never reorder the sim's array: force-graph mutates
  // x/y in place and relies on object identity, not position). Node ids are `${type}:${rowId}`, so an
  // id sort would group every type together along the backbone ring — re-creating the exact per-colour
  // clustering we are trying to kill. Hashing the id shuffles types uniformly, so the backbone AND the
  // chords all connect arbitrary-type neighbours → no per-colour spring subset → one rainbow blob.
  const ord = nodes.slice().sort((a, b) => (hash(a.id) - hash(b.id)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const seen = new Set<number>();
  const links: NeuronLink[] = [];
  const add = (i: number, j: number) => {
    if (i === j || i < 0 || j < 0 || i >= N || j >= N) return;
    const a = i < j ? i : j;
    const b = i < j ? j : i;
    const key = a * N + b;            // unique up to ~94M nodes (< 2^53); MAX_RENDER=4000 is safe
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source: ord[a].id, target: ord[b].id });
  };

  for (let i = 0; i < N; i++) {
    add(i, (i + 1) % N); // (1) backbone ring → one connected component, degree >= 2
    if (N > 6) {         // (2) long-range chords across the order → collapse the ring's hole → filled disc
      const h = hash(ord[i].id);
      const bases = [N >> 1, Math.floor(N / 3), Math.floor(N / 7) || 1]; // ~diametric + thirds + sevenths
      for (let c = 0; c < CHORDS_PER_NODE; c++) {
        const jitter = ((h >>> (c * 8)) & 0xff) % Math.max(1, Math.floor(N / 12) + 1); // de-band
        add(i, (i + ((bases[c] + jitter) % N)) % N);
      }
    }
  }

  // Mark ~PARTICLE_CAP links (by index) to carry a travelling "firing" pulse — an exact cap
  // regardless of edge count keeps the animation smooth at thousands of edges.
  const every = Math.max(1, Math.ceil(links.length / PARTICLE_CAP));
  for (let i = 0; i < links.length; i++) links[i].__p = i % every === 0 ? 1 : 0;
  return links;
}
