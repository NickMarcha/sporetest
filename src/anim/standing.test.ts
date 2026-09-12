import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCreature } from '../creature/creature.ts';
import { createAttachedLimb } from '../creature/attachment.ts';
import { createField } from '../field/field.ts';
import { meshField } from '../mesh/mesh.ts';
import { createRig } from '../rig/rig.ts';
import { createPose } from './pose.ts';
import { createStanding, writeStandingPose } from './standing.ts';

function fixture(count: number, unequal = false) {
  const creature = createCreature(); let id = 0;
  for (let foot = 0; foot < count; foot++) {
    const side = foot % 2 ? -1 : 1;
    const limb = createAttachedLimb(creature, { position: [-0.4 + Math.floor(foot / 2) * 0.8, -0.2, side * 0.65], normal: [0, 0, side] }, 'leg', () => `s${id++}`);
    if (unequal && foot % 2) for (const segment of limb.segments) segment.position[1] *= 0.75;
    creature.parts.push(limb);
  }
  const skin = meshField(createField(creature)), rig = createRig(creature, skin), pose = createPose(rig.bones);
  const stance = createStanding(skin, rig);
  return { creature, skin, rig, pose, stance };
}

test('one, two and four feet stand on a fixed floor without altering authored data', () => {
  for (const count of [1, 2, 4]) {
    const state = fixture(count), before = structuredClone(state.creature);
    writeStandingPose(state.skin, state.rig, state.stance, 0, state.pose);
    assert.equal(state.stance.contacts.length, count);
    assert.equal(state.stance.grounded, count, String(state.stance.gaps));
    assert.ok(state.stance.maximumError < 0.01);
    assert.deepEqual(state.creature, before);
    assert.ok(state.pose.creature.every(matrix => matrix.every(Number.isFinite)));
  }
});

test('unequal legs contact the floor after body-height and sole corrections', () => {
  const state = fixture(2, true);
  writeStandingPose(state.skin, state.rig, state.stance, -2, state.pose);
  assert.equal(state.stance.grounded, 2, String(state.stance.gaps));
  assert.ok(state.stance.maximumError < 0.01);
  for (const contact of state.stance.contacts) {
    const goal = contact.goal * 3;
    assert.equal(state.stance.ik.goals[goal], state.stance.restGoals[goal]);
    assert.equal(state.stance.ik.goals[goal + 2], state.stance.restGoals[goal + 2]);
  }
});

test('floor height is translation-covariant and repeated solves do not accumulate drift', () => {
  const state = fixture(2), firstMatrix = state.pose.local[0], contacts = state.stance.contactPositions;
  writeStandingPose(state.skin, state.rig, state.stance, 0, state.pose);
  const expected = structuredClone(state.pose);
  writeStandingPose(state.skin, state.rig, state.stance, 3, state.pose);
  state.pose.creature.forEach((matrix, index) => matrix.forEach((value, axis) => {
    assert.ok(Math.abs(value - expected.creature[index][axis] - (axis === 13 ? 3 : 0)) < 1e-4);
  }));
  writeStandingPose(state.skin, state.rig, state.stance, 0, state.pose);
  assert.deepEqual(state.pose, expected);
  assert.equal(state.pose.local[0], firstMatrix); assert.equal(state.stance.contactPositions, contacts);
});

test('no-foot creatures remain at rest and invalid floors are rejected', () => {
  const state = fixture(0);
  writeStandingPose(state.skin, state.rig, state.stance, 0, state.pose);
  assert.equal(state.stance.contacts.length, 0);
  state.pose.creature.forEach((matrix, bone) => matrix.forEach((value, axis) => assert.ok(Math.abs(value - state.rig.bones[bone].restCreature[axis]) < 1e-5)));
  assert.throws(() => writeStandingPose(state.skin, state.rig, state.stance, NaN, state.pose));
});

test('a fixed foot that cannot reach reports missed contact and keeps the rest torso above ground', () => {
  const creature = createCreature(); creature.spine = creature.spine.slice(0, 1);
  creature.spine[0].position = [0, 0, 0]; creature.spine[0].radius = 0.8;
  let id = 0;
  const limb = createAttachedLimb(creature, { position: [0, 0, 0.8], normal: [0, 0, 1] }, 'leg', () => `fixed${id++}`);
  limb.segments = limb.segments.slice(0, 1); creature.parts.push(limb);
  const skin = meshField(createField(creature)), rig = createRig(creature, skin), pose = createPose(rig.bones), stance = createStanding(skin, rig);
  writeStandingPose(skin, rig, stance, 0, pose);
  assert.ok(stance.bodyShift + stance.bodyBottom >= -1e-6);
  assert.ok(stance.maximumError > 0.01);
  assert.equal(stance.grounded, 0);
  assert.ok(pose.creature.every(matrix => matrix.every(Number.isFinite)));
});
