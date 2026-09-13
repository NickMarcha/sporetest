import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, createCreature, parseRecipe, replayRecipe, validateCreature } from './creature.ts';
import type { Recipe } from './creature.ts';

test('recipe replay round-trips without modifying its base or mutation inputs', () => {
  const base = createCreature();
  const savedBase = structuredClone(base);
  const recipe: Recipe = { base, mutations: [
    { type: 'move', id: 'v3', position: [0, 1, 0.5] },
    { type: 'radius', id: 'v3', radius: 0.9 },
    { type: 'color', color: '#aabbcc' },
  ] };
  const actual = replayRecipe(JSON.parse(JSON.stringify(recipe)) as Recipe);
  assert.deepEqual(actual.spine[2].position, [0, 1, 0.5]);
  assert.equal(actual.spine[2].radius, 0.9);
  assert.equal(actual.skinColor, '#aabbcc');
  assert.deepEqual(base, savedBase);
  actual.spine[0].position[0] = 99;
  assert.deepEqual(base, savedBase);
});

test('stable identifiers survive insertion and deletion', () => {
  let creature = createCreature();
  creature = applyMutation(creature, { type: 'insert', after: 'v1', vertebra: { id: 'extra', position: [-1.2, 0, 0], radius: 0.4, orientation: [0, 0, 0, 1] } });
  creature = applyMutation(creature, { type: 'radius', id: 'v3', radius: 1 });
  creature = applyMutation(creature, { type: 'remove', id: 'extra' });
  assert.equal(creature.spine[2].id, 'v3');
  assert.equal(creature.spine[2].radius, 1);
});

test('degenerate geometry is allowed, invalid numeric data is rejected', () => {
  const creature = createCreature();
  creature.spine.forEach(vertebra => { vertebra.position = [0, 0, 0]; });
  assert.doesNotThrow(() => validateCreature(creature));
  assert.throws(() => applyMutation(creature, { type: 'radius', id: 'v1', radius: 0 }));
  assert.throws(() => applyMutation(creature, { type: 'move', id: 'v1', position: [NaN, 0, 0] }));
  assert.throws(() => applyMutation(creature, { type: 'remove', id: 'missing' }));
  assert.throws(() => validateCreature({ ...creature, spine: [] }));
  assert.throws(() => validateCreature({ ...creature, spine: [creature.spine[0], creature.spine[0]] }));
  assert.throws(() => validateCreature({ ...creature, spine: [{ ...creature.spine[0], orientation: [0, 0, 0, 0] }] }));
});

test('parsing a recipe accepts saved files and rejects malformed ones with a message', () => {
  const creature = createCreature();
  const recipe: Recipe = {
    base: creature,
    mutations: [{ type: 'radius', id: 'v3', radius: 1.1 }, { type: 'color', color: '#c98f6b' }],
  };
  const parsed = parseRecipe(JSON.stringify(recipe));
  assert.deepEqual(parsed, recipe);
  assert.deepEqual(replayRecipe(parsed), applyMutation(applyMutation(creature, recipe.mutations[0]), recipe.mutations[1]));

  assert.throws(() => parseRecipe('{not json'), /valid JSON/);
  assert.throws(() => parseRecipe('[]'), /base creature/);
  assert.throws(() => parseRecipe(JSON.stringify({ base: { spine: [] }, mutations: [] })), /skin colour/);
  assert.throws(() => parseRecipe(JSON.stringify({ base: creature, mutations: [{}] })), /needs a type/);
  assert.throws(() => parseRecipe(JSON.stringify({ base: { ...creature, spine: [] }, mutations: [] })), /at least one vertebra/);
  assert.throws(() => parseRecipe(JSON.stringify({ base: creature, mutations: [{ type: 'move', id: 'missing', position: [0, 0, 0] }] })), /No vertebra/);
});
