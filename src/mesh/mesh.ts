import ndarray from 'ndarray';
import surfaceNets from 'surface-nets';
import { evaluateNormal, evaluateProvenance, ISOVALUE, kernel } from '../field/field.ts';
import type { Field } from '../field/field.ts';
import type { Position } from '../creature/creature.ts';

export type Skin = {
  positions: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  provenance: { sourceIds: string[]; offsets: Uint32Array; sources: Uint32Array; values: Float32Array };
  cellSize: number;
  sampledCells: number;
};

/** Full per-edit baseline. No renderer types, clocks, or persistent caches. */
export function meshField(field: Field, requestedCellSize = field.minimumRadius / 4): Skin {
  if (!Number.isFinite(requestedCellSize) || requestedCellSize <= 0) throw new Error('Cell size must be positive.');
  let cellSize = requestedCellSize;
  let shape = [0, 0, 0];
  let origin: Position = [0, 0, 0];
  const setGrid = () => {
    origin = field.bounds.min.map(value => Math.floor(value / cellSize) * cellSize - cellSize) as Position;
    shape = field.bounds.max.map((value, axis) => Math.ceil((value - origin[axis]) / cellSize) + 2);
  };
  setGrid();
  // Bound memory for long, thin or extremely edited creatures by reducing sampling resolution.
  while (shape[0] * shape[1] * shape[2] > 1_500_000) {
    cellSize *= 1.25;
    setGrid();
  }
  const [nx, ny, nz] = shape;
  const samples = new Float32Array(nx * ny * nz);
  samples.fill(-ISOVALUE);
  // Splat each compact contribution into its local box. The package still remeshes the full grid.
  for (const contribution of field.contributions) {
    const lo = contribution.center.map((v, axis) => Math.max(0, Math.ceil((v - contribution.support - origin[axis]) / cellSize)));
    const hi = contribution.center.map((v, axis) => Math.min(shape[axis] - 1, Math.floor((v + contribution.support - origin[axis]) / cellSize)));
    const supportSquared = contribution.support ** 2;
    for (let x = lo[0]; x <= hi[0]; x++) {
      const dx2 = (origin[0] + x * cellSize - contribution.center[0]) ** 2;
      for (let y = lo[1]; y <= hi[1]; y++) {
        const dxy2 = dx2 + (origin[1] + y * cellSize - contribution.center[1]) ** 2;
        if (dxy2 >= supportSquared) continue;
        for (let z = lo[2]; z <= hi[2]; z++) {
          const distanceSquared = dxy2 + (origin[2] + z * cellSize - contribution.center[2]) ** 2;
          samples[(x * ny + y) * nz + z] += contribution.strength * kernel(distanceSquared, supportSquared);
        }
      }
    }
  }
  const surface = surfaceNets(ndarray(samples, shape), 0);
  const positions = new Float32Array(surface.positions.length * 3);
  const normals = new Float32Array(positions.length);
  const offsets = new Uint32Array(surface.positions.length + 1);
  const sources: number[] = [];
  const values: number[] = [];
  surface.positions.forEach((position, index) => {
    const x = origin[0] + position[0] * cellSize;
    const y = origin[1] + position[1] * cellSize;
    const z = origin[2] + position[2] * cellSize;
    positions.set([x, y, z], index * 3);
    normals.set(evaluateNormal(field, x, y, z), index * 3);
    offsets[index] = sources.length;
    evaluateProvenance(field, x, y, z).forEach((value, source) => {
      if (value > 0) { sources.push(source); values.push(value); }
    });
  });
  offsets[surface.positions.length] = sources.length;
  // The package winds toward increasing values. Our field is positive inside.
  const triangles = new Uint32Array(surface.cells.length * 3);
  surface.cells.forEach(([a, b, c], index) => triangles.set([c, b, a], index * 3));
  return {
    positions, normals, triangles,
    provenance: { sourceIds: [...field.sourceIds], offsets, sources: new Uint32Array(sources), values: new Float32Array(values) },
    cellSize, sampledCells: samples.length,
  };
}
