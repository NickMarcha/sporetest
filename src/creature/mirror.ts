import { mat4, quat } from 'gl-matrix';
import { allLimbs } from './creature.ts';
import type { Creature, Limb, Orientation } from './creature.ts';
import { resolveStructure } from './structure.ts';

/** Pair dependencies follow attachment ancestry, independent of their JSON array order. */
export function orderMirrorPairs(creature: Creature) {
  const parents = new Map<string, string | null>();
  function visit(parts: Limb[], parent: string | null) {
    for (const part of parts) { parents.set(part.id, parent); visit(part.parts, part.id); }
  }
  visit(creature.parts, null);
  const pairOf = new Map(creature.mirrorPairs.flatMap((pair, index) => pair.map(id => [id, index] as const)));
  const dependencies = creature.mirrorPairs.map(pair => {
    const required = new Set<number>();
    for (const id of pair) {
      let parent = parents.get(id);
      while (parent) {
        const dependency = pairOf.get(parent);
        if (dependency !== undefined) required.add(dependency);
        parent = parents.get(parent);
      }
    }
    return required;
  });
  const done = new Set<number>(), ordered: Array<[string, string]> = [];
  while (done.size < creature.mirrorPairs.length) {
    const index = dependencies.findIndex((required, index) => !done.has(index) && [...required].every(dependency => done.has(dependency)));
    if (index < 0) throw new Error('Mirror links cannot create cyclic attachment dependencies.');
    done.add(index); ordered.push(creature.mirrorPairs[index]);
  }
  return ordered;
}

/** Remove the other half of a deleted pair, including dependent branches. */
export function pruneMirrorPairs(creature: Creature) {
  let changed = true;
  while (changed) {
    changed = false;
    const ids = new Set(allLimbs(creature.parts).map(limb => limb.id));
    const remove = new Set<string>();
    creature.mirrorPairs = creature.mirrorPairs.filter(pair => {
      if (pair.every(id => ids.has(id))) return true;
      pair.forEach(id => remove.add(id)); changed = true; return false;
    });
    function prune(parts: Limb[]): Limb[] {
      return parts.filter(part => !remove.has(part.id)).map(part => { part.parts = prune(part.parts); return part; });
    }
    creature.parts = prune(creature.parts);
  }
}

/** Reflect authored rest transforms across creature-space Z = 0, per edit only. */
export function synchronizeMirrors(creature: Creature, before: Creature, editedId?: string) {
  const flip = (value: number) => value === 0 ? 0 : -value;
  const edited = allLimbs(creature.parts).find(limb => limb.id === editedId);
  const driven = new Set(edited ? allLimbs([edited]).map(limb => limb.id) : []);
  const previous = new Map(allLimbs(before.parts).map(limb => [limb.id, limb]));
  const usedIds = new Set([...creature.spine.map(vertebra => vertebra.id), ...allLimbs(creature.parts).flatMap(limb => [limb.id, ...limb.segments.map(segment => segment.id)])]);
  function newId(sourceId: string) {
    let id = `mirror:${sourceId}`, suffix = 1;
    while (usedIds.has(id)) id = `mirror:${sourceId}:${suffix++}`;
    usedIds.add(id); return id;
  }
  for (const [first, second] of orderMirrorPairs(creature)) {
    if (!creature.mirrorPairs.some(pair => pair[0] === first && pair[1] === second)) continue;
    const limbs = allLimbs(creature.parts);
    const source = limbs.find(limb => limb.id === (driven.has(second) ? second : first))!;
    const target = limbs.find(limb => limb.id === (source.id === first ? second : first))!;
    const resolved = resolveStructure(creature).sources;
    const parent = resolved.find(item => item.id === source.socket.sourceId)!;
    const targetParent = resolved.find(item => item.id === target.socket.sourceId)!;
    const frame = mat4.fromRotationTranslation(mat4.create(), parent.orientation, parent.position);
    mat4.multiply(frame, frame, mat4.fromRotationTranslation(mat4.create(), source.socket.orientation, source.socket.position));
    // S * frame * S is a proper rotation plus reflected translation; no negative scale reaches the rig.
    for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
      frame[column * 4 + row] *= (row === 2 ? -1 : 1) * (column === 2 ? -1 : 1);
    }
    const inverseParent = mat4.fromRotationTranslation(mat4.create(), targetParent.orientation, targetParent.position);
    mat4.invert(inverseParent, inverseParent); mat4.multiply(frame, inverseParent, frame);
    const orientation: Orientation = [0, 0, 0, 1];
    mat4.getRotation(orientation, frame); quat.normalize(orientation, orientation);
    for (let index = 0; index < 4; index++) if (orientation[index] === 0) orientation[index] = 0;
    target.socket = { sourceId: target.socket.sourceId, position: [frame[12], frame[13], frame[14]], orientation };
    const oldSource = previous.get(source.id) ?? source;
    const oldTarget = previous.get(target.id) ?? target;
    const corresponding = new Map(oldSource.segments.map((segment, index) => [segment.id, oldTarget.segments[index]?.id]));
    target.segments = source.segments.map(segment => ({
      id: corresponding.get(segment.id) ?? newId(segment.id),
      position: [segment.position[0], segment.position[1], flip(segment.position[2])],
      orientation: [flip(segment.orientation[0]), flip(segment.orientation[1]), segment.orientation[2], segment.orientation[3]],
      radius: segment.radius,
    }));
    target.cap = source.cap;
    const sources = new Set(target.segments.map(segment => segment.id));
    target.parts = target.parts.filter(part => sources.has(part.socket.sourceId));
    pruneMirrorPairs(creature);
  }
}
