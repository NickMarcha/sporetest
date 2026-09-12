import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allLimbs, applyMutation, createCreature, replayRecipe, validateCreature } from './creature.ts';
import type { Creature, Limb, Recipe } from './creature.ts';
import { createAttachedLimb, moveLimbSegment } from './attachment.ts';
import { resolveStructure } from './structure.ts';

function makePair(creature = createCreature()): [Limb, Limb] {
  let index = 0; const id = () => `limb-${allLimbs(creature.parts).length}-${index++}`;
  return [createAttachedLimb(creature, { position: [0, 0, 0.76], normal: [0, 0, 1] }, 'leg', id),
    createAttachedLimb(creature, { position: [0, 0, -0.76], normal: [0, 0, -1] }, 'leg', id)];
}
function assertMirrored(creature: Creature) {
  const resolved = resolveStructure(creature).sources;
  const limbs = allLimbs(creature.parts);
  for (const [a, b] of creature.mirrorPairs) {
    const first = limbs.find(limb => limb.id === a)!, second = limbs.find(limb => limb.id === b)!;
    assert.equal(first.segments.length, second.segments.length);
    first.segments.forEach((segment, index) => {
      const p = resolved.find(source => source.id === segment.id)!.position;
      const q = resolved.find(source => source.id === second.segments[index].id)!.position;
      p.forEach((value, axis) => assert.ok(Math.abs(value - q[axis] * (axis === 2 ? -1 : 1)) < 1e-5));
      assert.equal(segment.radius, second.segments[index].radius);
    });
  }
}

test('a pair stays mirrored when dragging either side, and survives recipe replay', () => {
  const base = createCreature(), limbs = makePair(base);
  const recipe: Recipe = { base, mutations: [{ type: 'attach-pair', limbs }] };
  let creature = replayRecipe(recipe);
  for (const [index, position] of [[0, [0.4, -0.9, 1.5]], [1, [-0.2, -0.8, -1.7]]] as const) {
    const mutation = moveLimbSegment(creature, limbs[index].segments[1].id, [...position]);
    recipe.mutations.push(mutation); creature = applyMutation(creature, mutation); assertMirrored(creature);
  }
  assert.deepEqual(replayRecipe(JSON.parse(JSON.stringify(recipe)) as Recipe), creature);
  assert.equal(base.mirrorPairs.length, 0);
});

test('socket, radius, cap, and segment count edits synchronize without renaming surviving segments', () => {
  let creature = applyMutation(createCreature(), { type: 'attach-pair', limbs: makePair() });
  const partnerIds = creature.parts[1].segments.map(segment => segment.id);
  let limb = structuredClone(creature.parts[0]);
  limb.socket.position = [0.2, -0.1, 0.9];
  limb.socket.orientation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  limb.segments[1].radius = 0.33; limb.cap = 'grasper';
  limb.segments.splice(1, 0, { ...structuredClone(limb.segments[0]), id: 'inserted', position: [0.2, -0.3, 0.2] });
  creature = applyMutation(creature, { type: 'replace-limb', limb });
  assertMirrored(creature);
  assert.equal(creature.parts[1].cap, 'grasper');
  assert.equal(creature.parts[1].segments[2].id, partnerIds[1]);
  limb = structuredClone(creature.parts[1]); limb.segments.splice(1, 1);
  creature = applyMutation(creature, { type: 'replace-limb', limb });
  assertMirrored(creature);
  assert.deepEqual(creature.parts[1].segments.map(segment => segment.id), partnerIds);
});

test('unlinking permits asymmetric edits, while linked removal removes both sides', () => {
  const paired = applyMutation(createCreature(), { type: 'attach-pair', limbs: makePair() });
  const unlinked = applyMutation(paired, { type: 'unlink', id: paired.parts[0].id });
  const changed = applyMutation(unlinked, moveLimbSegment(unlinked, unlinked.parts[0].segments[2].id, [1, -2, 3]));
  assert.deepEqual(changed.parts[1], paired.parts[1]);
  assert.equal(changed.mirrorPairs.length, 0);
  const removed = applyMutation(paired, { type: 'remove-limb', id: paired.parts[1].id });
  assert.deepEqual(removed.parts, []); assert.deepEqual(removed.mirrorPairs, []);
  assert.equal(applyMutation(unlinked, { type: 'remove-limb', id: unlinked.parts[0].id }).parts.length, 1);
});

test('moving a spine source keeps linked limbs reflected in creature space', () => {
  let creature = applyMutation(createCreature(), { type: 'attach-pair', limbs: makePair() });
  creature = applyMutation(creature, { type: 'move', id: 'v3', position: [0.2, 0.3, 0.4] });
  assertMirrored(creature);
});

test('nested mirror pairs follow parent edits and deletion prunes both subtrees', () => {
  let creature = applyMutation(createCreature(), { type: 'attach-pair', limbs: makePair() });
  const branches = makePair(creature);
  branches.forEach((limb, index) => { limb.socket.sourceId = creature.parts[index].segments[1].id; limb.socket.position = [0, 0, index === 0 ? 0.2 : -0.2]; });
  creature = applyMutation(creature, { type: 'attach-pair', limbs: branches });
  assertMirrored(creature);
  creature.mirrorPairs.reverse();
  creature = applyMutation(creature, { type: 'move', id: 'v3', position: [0.1, 0.2, 0.3] });
  assertMirrored(creature);
  creature = applyMutation(creature, moveLimbSegment(creature, creature.parts[1].segments[1].id, [0.2, -0.5, -1.8]));
  assertMirrored(creature);
  const limb = structuredClone(creature.parts[0]); limb.segments.splice(1, 1); limb.parts = [];
  creature = applyMutation(creature, { type: 'replace-limb', limb });
  assert.equal(creature.mirrorPairs.length, 1); assert.equal(allLimbs(creature.parts).length, 2); assertMirrored(creature);
});

test('invalid mirror links are rejected', () => {
  const creature = applyMutation(createCreature(), { type: 'attach-pair', limbs: makePair() });
  creature.mirrorPairs.push([...creature.mirrorPairs[0]]);
  assert.throws(() => validateCreature(creature), /unpaired/);
  creature.mirrorPairs = [[creature.parts[0].id, 'missing']];
  assert.throws(() => validateCreature(creature), /unpaired/);
});
