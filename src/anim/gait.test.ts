import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCreature } from '../creature/creature.ts';
import { createAttachedLimb } from '../creature/attachment.ts';
import { createField } from '../field/field.ts';
import { meshField } from '../mesh/mesh.ts';
import { createRig } from '../rig/rig.ts';
import { createPose } from './pose.ts';
import { createWalking, writeWalkingPose } from './walking.ts';
import { sampleGait } from './gait.ts';

function fixture(count: number, unequal = false) {
  const creature = createCreature(); let id = 0;
  for (let foot = 0; foot < count; foot++) {
    const side = foot % 2 ? -1 : 1;
    const limb = createAttachedLimb(creature, { position: [-0.4 + Math.floor(foot / 2) * 0.8, -0.2, side * 0.65], normal: [0, 0, side] }, 'leg', () => `g${id++}`);
    if (unequal && foot % 2) {
      const root = limb.segments[0].position;
      for (const segment of limb.segments.slice(1)) for (let axis = 0; axis < 3; axis++) segment.position[axis] = root[axis] + (segment.position[axis] - root[axis]) * 0.4;
    }
    creature.parts.push(limb);
  }
  const skin = meshField(createField(creature)), rig = createRig(creature, skin), pose = createPose(rig.bones);
  const walk = createWalking(skin, rig, 0, pose);
  return { creature, skin, rig, pose, walk };
}

test('arbitrary foot counts have distinct triggers, finite motion, and planted targets fixed relative to the ground', () => {
  for (const count of [0, 1, 2, 3, 7]) {
    const { walk } = fixture(count), gait = walk.gait;
    assert.equal(gait.legs.length, count);
    for (const group of gait.groups) assert.equal(new Set(group.feet.map(foot => gait.legs[foot].trigger)).size, group.feet.length);
    for (const leg of gait.legs) {
      const period = gait.groups[leg.group].period;
      sampleGait(gait, period * (leg.trigger + 0.1));
      assert.equal(gait.planted[leg.foot], 1);
      const x = gait.offsets[leg.foot * 3] + gait.rootTravel[0], z = gait.offsets[leg.foot * 3 + 2] + gait.rootTravel[2];
      sampleGait(gait, period * (leg.trigger + 0.5));
      assert.equal(gait.planted[leg.foot], 1);
      assert.ok(Math.abs(gait.offsets[leg.foot * 3] + gait.rootTravel[0] - x) < 1e-9);
      assert.ok(Math.abs(gait.offsets[leg.foot * 3 + 2] + gait.rootTravel[2] - z) < 1e-9);
      sampleGait(gait, period * (leg.trigger + (1 + gait.duty) / 2));
      assert.equal(gait.planted[leg.foot], 0);
      assert.ok(gait.offsets[leg.foot * 3 + 1] > 0);
    }
    assert.ok(gait.offsets.every(Number.isFinite));
    assert.throws(() => sampleGait(gait, NaN));
    assert.throws(() => sampleGait(gait, -1));
  }
});

test('flight joins stance continuously in position and velocity', () => {
  const { walk } = fixture(2), gait = walk.gait, epsilon = 1e-5;
  for (const leg of gait.legs) for (const boundary of [gait.duty, 1]) {
    const time = gait.groups[leg.group].period * (leg.trigger + boundary);
    sampleGait(gait, time - epsilon); const before = gait.offsets.slice(leg.foot * 3, leg.foot * 3 + 3);
    sampleGait(gait, time); const at = gait.offsets.slice(leg.foot * 3, leg.foot * 3 + 3);
    sampleGait(gait, time + epsilon);
    for (let axis = 0; axis < 3; axis++) {
      const after = gait.offsets[leg.foot * 3 + axis];
      assert.ok(Math.abs(after - before[axis]) < 1e-4);
      assert.ok(Math.abs((after - at[axis]) / epsilon - (at[axis] - before[axis]) / epsilon) < 0.001);
    }
  }
});

test('different leg lengths form harmonized groups with slower cycles for longer legs', () => {
  const { walk } = fixture(4, true), groups = walk.gait.groups;
  assert.ok(groups.length > 1);
  for (const group of groups) {
    const ratio = group.period / groups[0].period;
    assert.ok([1, 2, 3, 4].some(denominator => Math.abs(ratio * denominator - Math.round(ratio * denominator)) < 1e-9));
  }
  assert.ok(groups.at(-1)!.period > groups[0].period);
});

test('walking skin contacts stay planted across a cycle, with reused buffers and no authored edits', () => {
  const state = fixture(2), { walk } = state, before = structuredClone(state.creature);
  const matrices = state.pose.local.slice(), goals = walk.stance.ik.goals, actual = walk.actual;
  let maximum = 0;
  for (let frame = 0; frame <= 90; frame++) {
    writeWalkingPose(state.skin, state.rig, walk, frame / 50, state.pose);
    maximum = Math.max(maximum, walk.maximumError);
    assert.ok(state.pose.creature.every(matrix => matrix.every(Number.isFinite)));
  }
  assert.ok(maximum < 0.01, `Maximum planted skin error ${maximum} m`);
  writeWalkingPose(state.skin, state.rig, walk, 0.37, state.pose); const expected = structuredClone(state.pose);
  writeWalkingPose(state.skin, state.rig, walk, 10, state.pose);
  writeWalkingPose(state.skin, state.rig, walk, 0.37, state.pose);
  assert.deepEqual(state.pose, expected);
  assert.deepEqual(state.creature, before);
  assert.equal(walk.stance.ik.goals, goals); assert.equal(walk.actual, actual);
  state.pose.local.forEach((matrix, index) => assert.equal(matrix, matrices[index]));
});
