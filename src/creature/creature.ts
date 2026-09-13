import { quat } from 'gl-matrix';
import { orderMirrorPairs, pruneMirrorPairs, synchronizeMirrors } from './mirror.ts';

/** Metres in the fixed creature authoring frame, right handed, +Y up. */
export type Position = [number, number, number];
/** Unit quaternion, [x, y, z, w], in creature space. */
export type Orientation = [number, number, number, number];
export type Vertebra = {
  id: string;
  position: Position;
  radius: number;
  orientation: Orientation;
};

export type Cap = 'foot' | 'grasper' | 'mouth' | 'eye' | 'tail';
/** Socket frame relative to its authored source, in metres and a unit quaternion. */
export type Socket = { sourceId: string; position: Position; orientation: Orientation };
/** Positions and orientations are relative to the limb's socket frame. */
export type LimbSegment = { id: string; position: Position; orientation: Orientation; radius: number };
export type Limb = { id: string; kind: 'limb'; socket: Socket; segments: LimbSegment[]; cap: Cap | null; parts: Limb[] };
export type Creature = { spine: Vertebra[]; parts: Limb[]; mirrorPairs: Array<[string, string]>; skinColor: string };
export type Mutation =
  | { type: 'move'; id: string; position: Position }
  | { type: 'radius'; id: string; radius: number }
  | { type: 'insert'; after: string; vertebra: Vertebra }
  | { type: 'remove'; id: string }
  | { type: 'color'; color: string }
  | { type: 'attach'; limb: Limb }
  | { type: 'attach-pair'; limbs: [Limb, Limb] }
  | { type: 'unlink'; id: string }
  | { type: 'replace-limb'; limb: Limb }
  | { type: 'remove-limb'; id: string };
export type Recipe = { base: Creature; mutations: Mutation[] };

export function validateCreature(creature: Creature) {
  if (creature.spine.length === 0) throw new Error('A spine needs at least one vertebra.');
  const ids = new Set<string>();
  for (const vertebra of creature.spine) {
    if (!vertebra.id || ids.has(vertebra.id)) throw new Error('Vertebra identifiers must be unique.');
    ids.add(vertebra.id);
    if (vertebra.position.length !== 3 || !vertebra.position.every(Number.isFinite)) {
      throw new Error('Vertebra positions must contain three finite numbers.');
    }
    if (!Number.isFinite(vertebra.radius) || vertebra.radius <= 0) throw new Error('Radius must be positive.');
    if (vertebra.orientation.length !== 4 || !vertebra.orientation.every(Number.isFinite) ||
      Math.abs(quat.length(vertebra.orientation) - 1) > 1e-5) throw new Error('Orientation must be a unit quaternion.');
  }
  function validateParts(parts: Limb[], sources: Set<string>) {
    for (const part of parts) {
      if (part.kind !== 'limb' || !part.id || ids.has(part.id)) throw new Error('Part identifiers must be unique.');
      ids.add(part.id);
      if (!sources.has(part.socket.sourceId)) throw new Error('Socket must reference its parent chain.');
      if (part.socket.position.length !== 3 || !part.socket.position.every(Number.isFinite) ||
        part.socket.orientation.length !== 4 || !part.socket.orientation.every(Number.isFinite) ||
        Math.abs(quat.length(part.socket.orientation) - 1) > 1e-5) throw new Error('Invalid socket frame.');
      if (part.segments.length === 0) throw new Error('A limb needs at least one segment.');
      const segmentIds = new Set<string>();
      for (const segment of part.segments) {
        if (!segment.id || ids.has(segment.id)) throw new Error('Segment identifiers must be unique.');
        ids.add(segment.id); segmentIds.add(segment.id);
        if (segment.position.length !== 3 || !segment.position.every(Number.isFinite) ||
          !Number.isFinite(segment.radius) || segment.radius <= 0 ||
          segment.orientation.length !== 4 || !segment.orientation.every(Number.isFinite) ||
          Math.abs(quat.length(segment.orientation) - 1) > 1e-5) throw new Error('Invalid limb segment.');
      }
      if (part.cap !== null && !['foot', 'grasper', 'mouth', 'eye', 'tail'].includes(part.cap)) throw new Error('Invalid cap.');
      validateParts(part.parts, segmentIds);
    }
  }
  validateParts(creature.parts, new Set(creature.spine.map(vertebra => vertebra.id)));
  const limbs = allLimbs(creature.parts);
  const linked = new Set<string>();
  for (const pair of creature.mirrorPairs) {
    if (pair.length !== 2 || pair.some(id => linked.has(id) || !limbs.some(limb => limb.id === id)) || pair[0] === pair[1]) throw new Error('Mirror pairs need two distinct, unpaired limbs.');
    pair.forEach(id => linked.add(id));
    const a = limbs.find(limb => limb.id === pair[0])!, b = limbs.find(limb => limb.id === pair[1])!;
    if (a.segments.length !== b.segments.length) throw new Error('Mirrored chains must have matching segments.');
    if (allLimbs(a.parts).some(limb => limb.id === b.id) || allLimbs(b.parts).some(limb => limb.id === a.id)) throw new Error('A limb cannot mirror its own descendant.');
  }
  orderMirrorPairs(creature);
  if (!/^#[\da-f]{6}$/i.test(creature.skinColor)) throw new Error('Skin colour must be a six-digit hex colour.');
}

export function allLimbs(parts: Limb[]): Limb[] {
  return parts.flatMap(part => [part, ...allLimbs(part.parts)]);
}

export function applyMutation(creature: Creature, mutation: Mutation): Creature {
  const next = structuredClone(creature);
  function attach(limb: Limb) {
    const owner = allLimbs(next.parts).find(parent => parent.segments.some(segment => segment.id === limb.socket.sourceId));
    (owner ? owner.parts : next.parts).push(structuredClone(limb));
  }
  if (mutation.type === 'color') next.skinColor = mutation.color;
  else if (mutation.type === 'attach') attach(mutation.limb);
  else if (mutation.type === 'attach-pair') {
    mutation.limbs.forEach(attach);
    next.mirrorPairs.push([mutation.limbs[0].id, mutation.limbs[1].id]);
  } else if (mutation.type === 'unlink') {
    if (!next.mirrorPairs.some(pair => pair.includes(mutation.id))) throw new Error('Limb has no mirror partner.');
    next.mirrorPairs = next.mirrorPairs.filter(pair => !pair.includes(mutation.id));
  } else if (mutation.type === 'replace-limb' || mutation.type === 'remove-limb') {
    const id = mutation.type === 'replace-limb' ? mutation.limb.id : mutation.id;
    const containers = [next.parts, ...allLimbs(next.parts).map(limb => limb.parts)];
    const container = containers.find(parts => parts.some(part => part.id === id));
    if (!container) throw new Error(`No limb with identifier ${id}.`);
    const index = container.findIndex(part => part.id === id);
    container.splice(index, 1, ...(mutation.type === 'replace-limb' ? [structuredClone(mutation.limb)] : []));
  }
  else {
    const id = mutation.type === 'insert' ? mutation.after : mutation.id;
    const index = next.spine.findIndex(vertebra => vertebra.id === id);
    if (index < 0) throw new Error(`No vertebra with identifier ${id}.`);
    switch (mutation.type) {
      case 'move': next.spine[index].position = [...mutation.position]; break;
      case 'radius': next.spine[index].radius = mutation.radius; break;
      case 'insert': next.spine.splice(index + 1, 0, structuredClone(mutation.vertebra)); break;
      case 'remove': next.spine.splice(index, 1); next.parts = next.parts.filter(part => part.socket.sourceId !== id); break;
    }
  }
  pruneMirrorPairs(next);
  if (mutation.type !== 'color' && mutation.type !== 'unlink') synchronizeMirrors(next, creature, mutation.type === 'replace-limb' ? mutation.limb.id : undefined);
  validateCreature(next);
  return next;
}

export function replayRecipe(recipe: Recipe): Creature {
  validateCreature(recipe.base);
  return recipe.mutations.reduce(applyMutation, structuredClone(recipe.base));
}

export function createCreature(): Creature {
  return {
    parts: [],
    mirrorPairs: [],
    skinColor: '#91ae9e',
    spine: [
      { id: 'v1', position: [-1.65, 0.25, 0], radius: 0.43, orientation: [0, 0, 0, 1] },
      { id: 'v2', position: [-0.9, 0.12, 0], radius: 0.67, orientation: [0, 0, 0, 1] },
      { id: 'v3', position: [0, 0, 0], radius: 0.76, orientation: [0, 0, 0, 1] },
      { id: 'v4', position: [0.85, 0.12, 0], radius: 0.54, orientation: [0, 0, 0, 1] },
      { id: 'v5', position: [1.55, 0.3, 0], radius: 0.27, orientation: [0, 0, 0, 1] },
    ],
  };
}
