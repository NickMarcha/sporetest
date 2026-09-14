import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCreature } from '../creature/creature.ts';
import { createAttachedLimb } from '../creature/attachment.ts';
import { deriveBones } from '../rig/skeleton.ts';
import { createRig } from '../rig/rig.ts';
import { createField } from '../field/field.ts';
import { meshField } from '../mesh/mesh.ts';
import { createPose } from './pose.ts';
import { createBalance, measureCentre, measureSupport } from './balance.ts';
import { createStanding, writeStandingPose, measureBalance } from './standing.ts';

function square() {
  const creature = createCreature(); creature.spine = creature.spine.slice(0, 1); creature.spine[0].position = [0, 0, 0];
  const skin = { positions: new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, 0, 0, 0, 0, 0, 0]),
    triangles: new Uint32Array([0, 1, 2, 0, 2, 3]), normals: new Float32Array(18),
    provenance: { sourceIds: ['v1'], offsets: new Uint32Array([0, 1, 2, 3, 4, 5, 6]), sources: new Uint32Array(6), values: new Float32Array(6).fill(1) },
    cellSize: 0.1, sampledCells: 0 };
  const rig = { bones: deriveBones(creature), weights: { offsets: skin.provenance.offsets, bones: new Uint32Array(6), values: skin.provenance.values } };
  return { skin, rig, balance: createBalance(skin, rig), pose: createPose(rig.bones) };
}

test('rest-area mass moments reproduce the surface centroid and follow a posed transform', () => {
  const { balance, pose } = square();
  assert.ok(Math.abs(balance.area - 4) < 1e-10);
  measureCentre(balance, pose);
  assert.ok(balance.centre.every(value => Math.abs(value) < 1e-10));
  pose.skinning[0][12] = 3; pose.skinning[0][13] = 2; pose.skinning[0][14] = -4;
  measureCentre(balance, pose);
  for (const [axis, value] of [3, 2, -4].entries()) assert.ok(Math.abs(balance.centre[axis] - value) < 1e-10);
});

test('support hull detects inside and outside projections regardless of input order or duplicates', () => {
  const { balance } = square();
  balance.points.set([1, 0, 1, -1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0, 1, 0, 0, 0]); balance.count = 6;
  const points = balance.points, order = balance.order, hull = balance.hull;
  measureSupport(balance, 0);
  assert.equal(balance.hullCount, 4); assert.equal(balance.inside, true); assert.equal(balance.distance, 0);
  balance.centre.set([3, 2, 0]); measureSupport(balance, 0);
  assert.equal(balance.inside, false); assert.equal(balance.distance, 2); assert.deepEqual([...balance.nearest], [1, 0, 0]);
  balance.centre.set([2, 4, 2]); measureSupport(balance, 3);
  assert.ok(Math.abs(balance.distance - Math.SQRT2) < 1e-10); assert.deepEqual([...balance.nearest], [1, 3, 1]);
  assert.equal(balance.points, points); assert.equal(balance.order, order); assert.equal(balance.hull, hull);
});

test('zero, one, duplicate and collinear contacts stay degenerate rather than inventing support area', () => {
  const { balance } = square();
  measureSupport(balance, 0); assert.equal(balance.hullCount, 0); assert.equal(balance.distance, Infinity); assert.equal(balance.inside, false);
  balance.points.set([2, 0, 0, 2, 0, 0]); balance.count = 2; measureSupport(balance, 0);
  assert.equal(balance.hullCount, 1); assert.equal(balance.distance, 2);
  balance.points.set([-2, 0, 0, 2, 0, 0, 0, 0, 0]); balance.count = 3; measureSupport(balance, 0);
  assert.equal(balance.hullCount, 2); assert.equal(balance.distance, 0);
  balance.centre.set([0, 0, 1]); measureSupport(balance, 0);
  assert.equal(balance.inside, false); assert.equal(balance.distance, 1);
});

test('only grounded planted foot skin contributes to support and measurement leaves the pose unchanged', () => {
  const creature = createCreature(); let id = 0;
  for (const side of [-1, 1]) creature.parts.push(createAttachedLimb(creature, {position:[0, -0.2, side * 0.65], normal:[0, 0, side]}, 'leg', () => `b${id++}`));
  const skin = meshField(createField(creature)), rig = createRig(creature, skin), pose = createPose(rig.bones), stance = createStanding(skin, rig);
  writeStandingPose(skin, rig, stance, 0, pose);
  const expected = structuredClone(pose);
  assert.equal(stance.balance.supportingFeet, 2); assert.ok(stance.balance.hullCount >= 3);
  measureBalance(skin, rig, stance, pose, 0, new Uint8Array([1, 0]));
  assert.equal(stance.balance.supportingFeet, 1);
  measureBalance(skin, rig, stance, pose, 0, new Uint8Array([0, 0]));
  assert.equal(stance.balance.hullCount, 0); assert.equal(stance.balance.distance, Infinity);
  stance.gaps[0] = 0.1; stance.gaps[1] = 0.1;
  measureBalance(skin, rig, stance, pose, 0);
  assert.equal(stance.balance.supportingFeet, 0);
  assert.deepEqual(pose, expected);
});

test('empty skin has no mass estimate or supporting area', () => {
  const { skin, rig, pose } = square(); skin.triangles = new Uint32Array();
  const balance = createBalance(skin, rig); measureCentre(balance, pose); measureSupport(balance, 0);
  assert.equal(balance.available, false); assert.equal(balance.inside, false); assert.ok(balance.centre.every(Number.isFinite));
});
