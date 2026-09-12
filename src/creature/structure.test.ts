import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, createCreature, replayRecipe, validateCreature } from './creature.ts';
import type { Limb, Recipe } from './creature.ts';
import { resolveStructure } from './structure.ts';
import { createField, evaluateField, evaluateProvenance, ISOVALUE } from '../field/field.ts';
import { meshField } from '../mesh/mesh.ts';
import { createRig } from '../rig/rig.ts';
import { createPose, skinPositions, writeBendPose } from '../anim/pose.ts';

function limb(id: string, sourceId = 'v3', side = 1): Limb {
  return { id, kind: 'limb', socket: { sourceId, position: [0, 0, 0.5 * side], orientation: [0, 0, 0, 1] },
    segments: [
      { id: `${id}-a`, position: [0, 0, 0], radius: 0.25, orientation: [0, 0, 0, 1] },
      { id: `${id}-b`, position: [0, -0.6, side * 0.6], radius: 0.2, orientation: [0, 0, 0, 1] },
      { id: `${id}-c`, position: [0, -1.2, side * 0.8], radius: 0.15, orientation: [0, 0, 0, 1] },
    ], cap: 'foot', parts: [] };
}
const close = (a: number, b: number, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('recursive sockets compose parent orientation, socket orientation, and segment position', () => {
  const creature = createCreature();
  creature.spine[2].position = [3, 4, 5];
  creature.spine[2].orientation = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const arm = limb('arm');
  arm.socket.position = [1, 0, 0];
  arm.socket.orientation = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  arm.segments[0].position = [1, 0, 0];
  const branch = limb('branch', 'arm-a');
  branch.socket.position = [1, 0, 0];
  arm.parts.push(branch); creature.parts.push(arm);
  validateCreature(creature);
  const resolved = resolveStructure(creature);
  const a = resolved.sources.find(source => source.id === 'arm-a')!;
  [2, 5, 5].forEach((value, axis) => close(a.position[axis], value));
  const b = resolved.sources.find(source => source.id === 'branch-a')!;
  [1, 5, 5].forEach((value, axis) => close(b.position[axis], value));
  assert.equal(b.parentId, a.id);
});

test('limb recipes replay recursively and removal prunes only the attached subtree', () => {
  const base = createCreature();
  const recipe: Recipe = { base, mutations: [
    { type: 'attach', limb: limb('near') }, { type: 'attach', limb: limb('far', 'v2', -1) },
    { type: 'attach', limb: limb('branch', 'near-b') },
  ] };
  const creature = replayRecipe(JSON.parse(JSON.stringify(recipe)) as Recipe);
  assert.equal(creature.parts[0].parts[0].id, 'branch');
  assert.deepEqual(base.parts, []);
  const removed = applyMutation(creature, { type: 'remove', id: 'v3' });
  assert.deepEqual(removed.parts.map(part => part.id), ['far']);
  assert.equal(creature.parts.length, 2);
  const detached = applyMutation(creature, { type: 'remove-limb', id: 'branch' });
  assert.equal(detached.parts[0].parts.length, 0);
  assert.equal(detached.parts.length, 2);
});

test('invalid socket ownership and duplicate source identifiers are rejected', () => {
  const creature = applyMutation(createCreature(), { type: 'attach', limb: limb('arm') });
  assert.throws(() => applyMutation(creature, { type: 'attach', limb: limb('missing', 'absent') }), /parent chain/);
  assert.throws(() => applyMutation(creature, { type: 'attach', limb: limb('arm') }), /unique/);
  const bad = structuredClone(creature);
  bad.parts[0].parts.push(limb('branch', 'v1'));
  assert.throws(() => validateCreature(bad), /parent chain/);
  bad.parts = [limb('arm')]; bad.parts[0].segments[0].radius = NaN;
  assert.throws(() => validateCreature(bad), /Invalid limb segment/);
});

test('branched limb fields stay connected and retain every segment source', () => {
  const creature = createCreature();
  creature.parts = [limb('near'), limb('far', 'v2', -1)];
  creature.parts[0].parts = [limb('branch', 'near-b')];
  const structure = resolveStructure(creature), field = createField(creature);
  assert.deepEqual(field.sourceIds, structure.sources.map(source => source.id));
  for (const chain of structure.chains) {
    for (let index = 1; index < chain.length; index++) {
      const a = chain[index - 1].position, b = chain[index].position;
      for (let sample = 0; sample <= 10; sample++) {
        const t = sample / 10;
        const point = a.map((value, axis) => value + (b[axis] - value) * t);
        assert.ok(evaluateField(field, point[0], point[1], point[2]) > 0);
      }
    }
  }
  const p = structure.sources.at(-1)!.position;
  close(evaluateProvenance(field, ...p).reduce((a, b) => a + b), evaluateField(field, ...p) + ISOVALUE);
  // A cap is semantic metadata, never a new field contribution.
  const uncapped = structuredClone(creature); uncapped.parts[0].cap = null;
  assert.deepEqual(createField(uncapped), field);
});

test('branched skin binds at rest and limb flex leaves authored data and spine poses unchanged', () => {
  const creature = createCreature(); creature.parts = [limb('near'), limb('far', 'v2', -1)];
  creature.parts[0].parts = [limb('branch', 'near-b')];
  const saved = structuredClone(creature), field = createField(creature);
  const skin = meshField(field, 0.1), rig = createRig(creature, skin), pose = createPose(rig.bones);
  writeBendPose(rig.bones, 0, pose);
  const output = new Float32Array(skin.positions.length);
  skinPositions(skin.positions, rig.weights, pose, output);
  output.forEach((value, index) => close(value, skin.positions[index]));
  assert.equal(rig.bones.filter(bone => bone.cap === 'foot').length, 3);
  const branch = rig.bones.find(bone => bone.sourceId === 'branch-a')!;
  assert.equal(rig.bones[branch.parent].sourceId, 'near-b');
  writeBendPose(rig.bones, 0, pose, 0.3);
  rig.bones.forEach((bone, index) => {
    assert.ok(pose.creature[index].every(Number.isFinite));
    if (bone.kind === 'spine') pose.creature[index].forEach((value, axis) => close(value, bone.restCreature[axis]));
    if (bone.parent >= 0) {
      const parent = pose.creature[bone.parent];
      close(Math.hypot(pose.creature[index][12] - parent[12], pose.creature[index][13] - parent[13], pose.creature[index][14] - parent[14]),
        Math.hypot(bone.restLocal[12], bone.restLocal[13], bone.restLocal[14]));
    }
  });
  skinPositions(skin.positions, rig.weights, pose, output);
  assert.ok(output.some((value, index) => Math.abs(value - skin.positions[index]) > 0.05));
  assert.deepEqual(creature, saved);
});

test('moving an attachment source carries its limbs without rewriting socket data', () => {
  const creature = createCreature(); creature.parts = [limb('arm')];
  creature.parts[0].parts = [limb('branch', 'arm-c')];
  const before = resolveStructure(creature).sources;
  const moved = applyMutation(creature, { type: 'move', id: 'v3', position: [2, 3, 4] });
  const after = resolveStructure(moved).sources;
  after.forEach((source, index) => {
    if (source.kind === 'limb') [2, 3, 4].forEach((delta, axis) => close(source.position[axis] - before[index].position[axis], delta));
  });
  assert.deepEqual(moved.parts, creature.parts);
});

test('one-segment and coincident limbs retain finite binding and poses', () => {
  const creature = createCreature();
  creature.spine = [creature.spine[2]];
  const part = limb('collapsed'); part.socket.position = [0, 0, 0];
  part.segments.forEach(segment => { segment.position = [0, 0, 0]; });
  creature.parts = [part];
  for (const count of [3, 1]) {
    part.segments = part.segments.slice(0, count);
    const skin = meshField(createField(creature), 0.1), rig = createRig(creature, skin);
    const pose = createPose(rig.bones), output = new Float32Array(skin.positions.length);
    writeBendPose(rig.bones, 0.4, pose, 0.2);
    skinPositions(skin.positions, rig.weights, pose, output);
    assert.ok(output.every(Number.isFinite));
    assert.ok(rig.weights.values.every(Number.isFinite));
    assert.equal(rig.bones.length, count + 1);
    assert.throws(() => writeBendPose(rig.bones, 0, pose, NaN), /finite/);
  }
});
