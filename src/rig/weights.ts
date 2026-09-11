import type { Skin } from '../mesh/mesh.ts';
import type { Bone } from './skeleton.ts';

/** Sparse, normalised influences. Source IDs have already resolved to bone indices. */
export type Weights = { offsets: Uint32Array; bones: Uint32Array; values: Float32Array };

export function meshAdjacency(vertexCount: number, triangles: Uint32Array) {
  const neighbours = Array.from({ length: vertexCount }, () => new Set<number>());
  for (let index = 0; index < triangles.length; index += 3) {
    const a = triangles[index], b = triangles[index + 1], c = triangles[index + 2];
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) throw new Error('Triangle refers to a missing vertex.');
    if (a !== b) { neighbours[a].add(b); neighbours[b].add(a); }
    if (b !== c) { neighbours[b].add(c); neighbours[c].add(b); }
    if (c !== a) { neighbours[c].add(a); neighbours[a].add(c); }
  }
  return neighbours.map(set => [...set].sort((a, b) => a - b));
}

/** Jacobi relaxation: half the current weights, half the mean of adjacent vertices. */
export function bindWeights(skin: Skin, bones: Bone[], smoothingPasses = 4): Weights {
  if (!Number.isInteger(smoothingPasses) || smoothingPasses < 0 || smoothingPasses > 32) throw new Error('Smoothing passes must be an integer between 0 and 32.');
  const sourceToBone = new Map(bones.map((bone, index) => [bone.sourceId, index]));
  const provenance = skin.provenance;
  const sourceBones = provenance.sourceIds.map(id => {
    const bone = sourceToBone.get(id);
    if (bone === undefined) throw new Error(`Provenance source ${id} has no bone.`);
    return bone;
  });
  const vertexCount = skin.positions.length / 3;
  if (provenance.offsets.length !== vertexCount + 1) throw new Error('Provenance does not match this skin.');
  let weights = Array.from({ length: vertexCount }, (_, vertex) => {
    const row = new Map<number, number>();
    let sum = 0;
    for (let index = provenance.offsets[vertex]; index < provenance.offsets[vertex + 1]; index++) {
      const value = provenance.values[index];
      const bone = sourceBones[provenance.sources[index]];
      if (!Number.isFinite(value) || value < 0 || bone === undefined) throw new Error('Invalid skin provenance.');
      row.set(bone, (row.get(bone) ?? 0) + value);
      sum += value;
    }
    if (!(sum > 0)) throw new Error('Every skin vertex needs positive source density.');
    for (const [bone, value] of row) row.set(bone, value / sum);
    return row;
  });
  if (smoothingPasses > 0) {
    const adjacency = meshAdjacency(vertexCount, skin.triangles);
    for (let pass = 0; pass < smoothingPasses; pass++) {
      const previous = weights;
      weights = previous.map((row, vertex) => {
        const neighbours = adjacency[vertex];
        if (neighbours.length === 0) return new Map(row);
        const next = new Map<number, number>();
        for (const [bone, value] of row) next.set(bone, value * 0.5);
        const factor = 0.5 / neighbours.length;
        for (const neighbour of neighbours) {
          for (const [bone, value] of previous[neighbour]) next.set(bone, (next.get(bone) ?? 0) + value * factor);
        }
        return next;
      });
    }
  }
  const offsets = new Uint32Array(vertexCount + 1);
  const influences: number[] = [], values: number[] = [];
  weights.forEach((row, vertex) => {
    offsets[vertex] = influences.length;
    const entries = [...row].filter(([, value]) => value > 0).sort(([a], [b]) => a - b);
    const sum = entries.reduce((total, [, value]) => total + value, 0);
    for (const [bone, value] of entries) { influences.push(bone); values.push(value / sum); }
  });
  offsets[vertexCount] = influences.length;
  return { offsets, bones: new Uint32Array(influences), values: new Float32Array(values) };
}

/** Explicit influence reduction for consumers with a fixed number of slots, such as Three.js. */
export function packWeights(weights: Weights, slots: number) {
  if (!Number.isInteger(slots) || slots < 1) throw new Error('At least one influence slot is required.');
  const vertexCount = weights.offsets.length - 1;
  const indices = new Uint32Array(vertexCount * slots);
  const values = new Float32Array(vertexCount * slots);
  let maximumDiscarded = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const entries: Array<{ bone: number; value: number }> = [];
    for (let index = weights.offsets[vertex]; index < weights.offsets[vertex + 1]; index++) {
      entries.push({ bone: weights.bones[index], value: weights.values[index] });
    }
    entries.sort((a, b) => b.value - a.value || a.bone - b.bone);
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    const kept = entries.slice(0, slots);
    const retained = kept.reduce((sum, entry) => sum + entry.value, 0);
    if (!(retained > 0)) throw new Error('Cannot pack a vertex with zero weight.');
    maximumDiscarded = Math.max(maximumDiscarded, Math.max(0, (total - retained) / total));
    kept.forEach((entry, slot) => {
      indices[vertex * slots + slot] = entry.bone;
      values[vertex * slots + slot] = entry.value / retained;
    });
  }
  return { indices, values, maximumDiscarded };
}
