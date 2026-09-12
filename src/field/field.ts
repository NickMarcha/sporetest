import { vec3 } from 'gl-matrix';
import { validateCreature } from '../creature/creature.ts';
import { resolveStructure } from '../creature/structure.ts';
import type { Source } from '../creature/structure.ts';
import type { Creature, Position } from '../creature/creature.ts';

type Contribution = {
  center: Position;
  support: number;
  strength: number;
  start: number;
  end: number;
  blend: number;
};
export type Field = {
  contributions: Contribution[];
  sourceIds: string[];
  bounds: { min: Position; max: Position };
  minimumRadius: number;
};

// Hecker's compact-support polynomial. An isolated ball meets the isosurface at its authored radius.
// https://chrishecker.com/My_Liner_Notes_for_Spore
export const ISOVALUE = (3 / 4) ** 4;
const LINE_DENSITY = 1 / (2 * (256 / 315) * Math.sqrt(3 / 4));

export function kernel(distanceSquared: number, supportSquared: number) {
  if (distanceSquared >= supportSquared) return 0;
  const falloff = 1 - distanceSquared / supportSquared;
  return falloff ** 4;
}

export function createField(creature: Creature): Field {
  validateCreature(creature);
  const structure = resolveStructure(creature);
  const sourceIds = structure.sources.map(source => source.id);
  const sourceIndices = new Map(sourceIds.map((id, index) => [id, index]));
  const contributions: Contribution[] = [];
  const min: Position = [Infinity, Infinity, Infinity];
  const max: Position = [-Infinity, -Infinity, -Infinity];
  const add = (center: Position, radius: number, strength: number, start: number, end = start, blend = 0) => {
    const support = radius * 2;
    contributions.push({ center, support, strength, start, end, blend });
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], center[axis] - support);
      max[axis] = Math.max(max[axis], center[axis] + support);
    }
  };
  let minimumRadius = Infinity;
  for (const chain of structure.chains) {
    // Consecutive coincident sources describe one location. Use its largest radius;
    // keep the original identifier map rather than adding density for duplicate controls.
    const samples: Array<Source & { source: number }> = [];
    chain.forEach(sourceData => {
      const source = sourceIndices.get(sourceData.id)!;
      const previous = samples.at(-1);
      if (previous && vec3.exactEquals(previous.position, sourceData.position)) {
        if (sourceData.radius > previous.radius) samples[samples.length - 1] = { ...sourceData, source };
      } else samples.push({ ...sourceData, source });
    });
    for (const sample of samples) minimumRadius = Math.min(minimumRadius, sample.radius);
    if (samples.length === 1) add([...samples[0].position], samples[0].radius, 1, samples[0].source);
    else {
      add([...samples[0].position], samples[0].radius, 0.5, samples[0].source);
      add([...samples.at(-1)!.position], samples.at(-1)!.radius, 0.5, samples.at(-1)!.source);
      for (let index = 0; index < samples.length - 1; index++) {
        const a = samples[index];
        const b = samples[index + 1];
        const length = vec3.distance(a.position, b.position);
        if (length === 0) continue;
        const count = Math.ceil(length / (Math.min(a.radius, b.radius) * 0.4));
        if (count > 100_000) throw new Error('Chain segment exceeds the field sampling budget.');
        // Midpoint quadrature approximates a continuous chain. Strength scales with spacing,
        // so subdividing a straight segment does not double its field density.
        for (let sample = 0; sample < count; sample++) {
          const blend = (sample + 0.5) / count;
          const center: Position = [0, 0, 0];
          vec3.lerp(center, a.position, b.position, blend);
          const radius = a.radius + (b.radius - a.radius) * blend;
          add(center, radius, LINE_DENSITY * length / count / radius, a.source, b.source, blend);
        }
      }
    }
  }
  return {
    contributions,
    sourceIds,
    bounds: { min, max },
    minimumRadius,
  };
}

/** Positive inside the skin. Coordinates and support radii are in creature-space metres. */
export function evaluateField(field: Field, x: number, y: number, z: number) {
  let value = -ISOVALUE;
  for (const contribution of field.contributions) {
    const dx = x - contribution.center[0];
    const dy = y - contribution.center[1];
    const dz = z - contribution.center[2];
    value += contribution.strength * kernel(dx * dx + dy * dy + dz * dz, contribution.support ** 2);
  }
  return value;
}

/** Unnormalised provenance at the actual mesh vertex, grouped by stable authored source. */
export function evaluateProvenance(field: Field, x: number, y: number, z: number) {
  const values = new Float64Array(field.sourceIds.length);
  for (const contribution of field.contributions) {
    const dx = x - contribution.center[0];
    const dy = y - contribution.center[1];
    const dz = z - contribution.center[2];
    const value = contribution.strength * kernel(dx * dx + dy * dy + dz * dz, contribution.support ** 2);
    values[contribution.start] += value * (1 - contribution.blend);
    values[contribution.end] += value * contribution.blend;
  }
  return values;
}

/** Unit outward normal from the negative field gradient, in creature space. */
export function evaluateNormal(field: Field, x: number, y: number, z: number): Position {
  const normal: Position = [0, 0, 0];
  for (const contribution of field.contributions) {
    const dx = x - contribution.center[0];
    const dy = y - contribution.center[1];
    const dz = z - contribution.center[2];
    const supportSquared = contribution.support ** 2;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared >= supportSquared) continue;
    const scale = 8 * contribution.strength / supportSquared * (1 - distanceSquared / supportSquared) ** 3;
    normal[0] += dx * scale;
    normal[1] += dy * scale;
    normal[2] += dz * scale;
  }
  // A zero gradient is possible at a critical point of a self-intersecting field.
  // Keep it finite; such geometry has no unique analytic normal.
  vec3.normalize(normal, normal);
  return normal;
}
