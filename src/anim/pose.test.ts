import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCreature } from '../creature/creature.ts';
import { createField } from '../field/field.ts';
import { meshField } from '../mesh/mesh.ts';
import { createRig } from '../rig/rig.ts';
import { createPose, evaluatePose, skinPositions, writeBendPose } from './pose.ts';

test('rest pose reproduces the skin, including nonzero root position', () => {
  const creature = createCreature();
  const skin = meshField(createField(creature));
  const rig = createRig(creature, skin);
  const pose = createPose(rig.bones);
  evaluatePose(rig.bones, pose);
  const output = new Float32Array(skin.positions.length);
  skinPositions(skin.positions, rig.weights, pose, output);
  output.forEach((value, index) => assert.ok(Math.abs(value - skin.positions[index]) < 2e-6));
});

test('root translation carries the entire bound skin by the same displacement', () => {
  const creature = createCreature();
  const skin = meshField(createField(creature));
  const rig = createRig(creature, skin);
  const pose = createPose(rig.bones);
  pose.local[0][12] += 2;
  pose.local[0][13] -= 0.5;
  evaluatePose(rig.bones, pose);
  const output = new Float32Array(skin.positions.length);
  skinPositions(skin.positions, rig.weights, pose, output);
  output.forEach((value, index) => {
    const delta = index % 3 === 0 ? 2 : index % 3 === 1 ? -0.5 : 0;
    assert.ok(Math.abs(value - skin.positions[index] - delta) < 2e-6);
  });
});

test('bend poses preserve bone distances, reuse buffers, and return exactly to rest', () => {
  const creature = createCreature();
  const before = structuredClone(creature);
  const skin = meshField(createField(creature));
  const rig = createRig(creature, skin);
  const pose = createPose(rig.bones);
  const firstMatrix = pose.local[0];
  const output = new Float32Array(skin.positions.length);
  writeBendPose(rig.bones, 1, pose);
  skinPositions(skin.positions, rig.weights, pose, output);
  assert.ok(output.some((value, index) => Math.abs(value - skin.positions[index]) > 0.1));
  for (let index = 1; index < rig.bones.length; index++) {
    const parent = rig.bones[index].parent;
    const a = pose.creature[parent], b = pose.creature[index];
    const rest = rig.bones[index].restLocal;
    assert.ok(Math.abs(Math.hypot(a[12] - b[12], a[13] - b[13], a[14] - b[14]) - Math.hypot(rest[12], rest[13], rest[14])) < 1e-6);
  }
  for (let frame = 0; frame < 120; frame++) writeBendPose(rig.bones, Math.sin(frame / 20), pose);
  writeBendPose(rig.bones, 0, pose);
  skinPositions(skin.positions, rig.weights, pose, output);
  output.forEach((value, index) => assert.ok(Math.abs(value - skin.positions[index]) < 2e-6));
  assert.equal(pose.local[0], firstMatrix);
  assert.deepEqual(creature, before);
});

test('one vertebra and coincident vertebrae bind and pose without NaNs', () => {
  for (const count of [1,3]) {
    const creature = createCreature();
    creature.spine = creature.spine.slice(0, count);
    creature.spine.forEach(vertebra => { vertebra.position = [0,0,0]; });
    const skin = meshField(createField(creature));
    const rig = createRig(creature, skin);
    const pose = createPose(rig.bones);
    writeBendPose(rig.bones, 1.3, pose);
    assert.ok(pose.skinning.every(matrix => matrix.every(Number.isFinite)));
    const output = new Float32Array(skin.positions.length);
    skinPositions(skin.positions, rig.weights, pose, output);
    output.forEach((value, index) => assert.ok(Math.abs(value - skin.positions[index]) < 1e-6));
  }
});
