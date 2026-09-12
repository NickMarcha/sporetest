import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mat4, vec3 } from 'gl-matrix';
import { createCreature } from '../creature/creature.ts';
import type { Limb } from '../creature/creature.ts';
import { deriveBones } from '../rig/skeleton.ts';
import { createPose, evaluatePose, skinPositions } from './pose.ts';
import { createLimbIK, solveLimbIK } from './limb-ik.ts';
import { createField } from '../field/field.ts';
import { meshField } from '../mesh/mesh.ts';
import { createRig } from '../rig/rig.ts';

function fixture() {
  const creature = createCreature();
  creature.spine = creature.spine.slice(0, 1);
  creature.spine[0].position = [2, 3, 4];
  const limb: Limb = { id: 'leg', kind: 'limb', cap: 'foot', parts: [],
    socket: { sourceId: 'v1', position: [0, 0, 0.7], orientation: [0, 0, 0, 1] },
    segments: [
      { id: 'hip', position: [0, 0, 0], orientation: [0, 0, 0, 1], radius: 0.25 },
      { id: 'knee', position: [0.5, -1, 0], orientation: [0, 0, 0, 1], radius: 0.2 },
      { id: 'foot', position: [0, -2, 0], orientation: [0, 0, 0, 1], radius: 0.15 },
    ] };
  creature.parts.push(limb);
  return creature;
}
function setup(creature = fixture()) {
  const bones = deriveBones(creature), base = createPose(bones), output = createPose(bones);
  evaluatePose(bones, base);
  const targets = bones.filter(bone => bone.cap !== null).map(bone => ({ boneId: bone.id, cap: bone.cap! }));
  const ik = createLimbIK(bones, targets);
  return { creature, bones, base, output, ik };
}
function near(actual: number, expected: number, tolerance = 1e-5) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}
function lengths(state: ReturnType<typeof setup>) {
  for (let index = 1; index < state.bones.length; index++) {
    const bone = state.bones[index], a = state.output.creature[bone.parent], b = state.output.creature[index];
    near(Math.hypot(b[12] - a[12], b[13] - a[13], b[14] - a[14]), Math.hypot(bone.restLocal[12], bone.restLocal[13], bone.restLocal[14]));
  }
  for (const matrix of state.output.creature) {
    assert.ok(matrix.every(Number.isFinite));
    near(mat4.determinant(matrix), 1);
  }
}

test('rest targets reproduce the base pose and leave creature and base untouched', () => {
  const state = setup(), before = structuredClone(state.creature), baseBefore = structuredClone(state.base);
  solveLimbIK(state.bones, state.ik, state.base, state.output);
  state.output.creature.forEach((matrix, bone) => matrix.forEach((value, axis) => near(value, state.base.creature[bone][axis])));
  assert.deepEqual(state.base, baseBefore); assert.deepEqual(state.creature, before);
  lengths(state);
});

test('reachable targets converge with fixed sockets, rigid lengths and reused pose buffers', () => {
  const state = setup(), positions = state.ik.positions, matrix = state.output.local[2];
  state.ik.goals[0] += 0.5; state.ik.goals[1] += 0.25; state.ik.goals[2] += 0.3;
  solveLimbIK(state.bones, state.ik, state.base, state.output);
  assert.ok(state.ik.errors[0] < 0.002, String(state.ik.errors[0]));
  for (let axis = 0; axis < 3; axis++) near(state.output.creature[1][12 + axis], state.base.creature[1][12 + axis]);
  assert.deepEqual(state.output.creature[0], state.base.creature[0]);
  assert.equal(state.ik.positions, positions); assert.equal(state.output.local[2], matrix);
  lengths(state);
});

test('unreachable and reversed targets remain finite with exact lengths and a reported residual', () => {
  const state = setup();
  for (const target of [[100, 50, -20], [2, 5, 4.7], [2, 3, 4.7]]) {
    state.ik.goals.set(target); solveLimbIK(state.bones, state.ik, state.base, state.output);
    lengths(state);
  }
  state.ik.goals.set([100, 50, -20]); solveLimbIK(state.bones, state.ik, state.base, state.output);
  assert.ok(state.ik.errors[0] > 90);
});

test('straight compressed and coincident chains escape singularities without NaNs', () => {
  for (const coincident of [false, true]) {
    const creature = fixture();
    creature.parts[0].segments[1].position = coincident ? [0, 0, 0] : [0, -1, 0];
    const state = setup(creature);
    state.ik.goals[1] += 0.5;
    solveLimbIK(state.bones, state.ik, state.base, state.output);
    lengths(state);
    if (!coincident) assert.ok(state.ik.errors[0] < 0.005, String(state.ik.errors[0]));
  }
});

test('shared branches solve together and inactive attachments follow the reconstructed parent', () => {
  const creature = fixture();
  creature.parts[0].parts.push({ id: 'branch', kind: 'limb', cap: 'grasper', parts: [],
    socket: { sourceId: 'knee', position: [0, 0, 0], orientation: [0, 0, 0, 1] },
    segments: [
      { id: 'branch-start', position: [0.3, 0, 0.2], orientation: [0, 0, 0, 1], radius: 0.12 },
      { id: 'branch-tip', position: [0.8, -0.5, 0.3], orientation: [0, 0, 0, 1], radius: 0.1 },
    ] });
  creature.parts[0].parts.push({ id: 'passive', kind: 'limb', cap: null, parts: [],
    socket: { sourceId: 'knee', position: [-0.2, 0, 0], orientation: [0, 0, 0, 1] },
    segments: [{ id: 'passive-tip', position: [-0.1, 0, 0], orientation: [0, 0, 0, 1], radius: 0.1 }] });
  const state = setup(creature);
  assert.equal(state.ik.crossConstraints.length, 1);
  // A rigid rotation about the fixed socket is a feasible two-target solution.
  const anchor = state.base.creature[1], rotation = mat4.create(), point = vec3.create();
  mat4.rotateY(rotation, rotation, 0.35);
  for (let goal = 0; goal < state.ik.goalParticles.length; goal++) {
    for (let axis = 0; axis < 3; axis++) point[axis] = state.ik.goals[goal * 3 + axis] - anchor[12 + axis];
    vec3.transformMat4(point, point, rotation);
    for (let axis = 0; axis < 3; axis++) state.ik.goals[goal * 3 + axis] = point[axis] + anchor[12 + axis];
  }
  solveLimbIK(state.bones, state.ik, state.base, state.output);
  assert.ok(state.ik.errors.every(error => error < 0.005), String(state.ik.errors));
  const passive = state.bones.findIndex(bone => bone.sourceId === 'passive-tip');
  assert.equal(state.ik.particleOf[passive], -1);
  assert.deepEqual(state.output.local[passive], state.base.local[passive]);
  assert.notDeepEqual(state.output.creature[passive], state.base.creature[passive]);
  lengths(state);
});

test('solves are path independent across a target trajectory and rigidly transformed base poses', () => {
  const state = setup(), originalGoals = state.ik.goals.slice();
  state.ik.goals[0] += 0.3;
  solveLimbIK(state.bones, state.ik, state.base, state.output);
  const expected = structuredClone(state.output);
  for (let frame = 0; frame < 120; frame++) {
    state.ik.goals[0] = originalGoals[0] + 0.3 * Math.cos(frame / 20);
    state.ik.goals[2] = originalGoals[2] + 0.3 * Math.sin(frame / 20);
    solveLimbIK(state.bones, state.ik, state.base, state.output); lengths(state);
  }
  state.ik.goals.set(originalGoals); state.ik.goals[0] += 0.3;
  solveLimbIK(state.bones, state.ik, state.base, state.output);
  assert.deepEqual(state.output, expected);
  const transform = mat4.create(), goal = vec3.create();
  mat4.translate(transform, transform, [-4, 1, 2]); mat4.rotateY(transform, transform, 0.7);
  mat4.multiply(state.base.local[0], transform, state.bones[0].restLocal);
  evaluatePose(state.bones, state.base);
  vec3.set(goal, state.ik.goals[0], state.ik.goals[1], state.ik.goals[2]); vec3.transformMat4(goal, goal, transform);
  state.ik.goals.set(goal); solveLimbIK(state.bones, state.ik, state.base, state.output);
  const matrix = mat4.create();
  state.output.creature.forEach((actual, index) => {
    mat4.multiply(matrix, transform, expected.creature[index]);
    actual.forEach((value, axis) => near(value, matrix[axis], 2e-5));
  });
});

test('no targets, one-segment limbs, and invalid target identities have explicit behavior', () => {
  const state = setup();
  const empty = createLimbIK(state.bones, []);
  solveLimbIK(state.bones, empty, state.base, state.output);
  assert.deepEqual(state.output, state.base);
  assert.throws(() => createLimbIK(state.bones, [{ boneId: 'limb:foot', cap: 'grasper' }]));
  assert.throws(() => createLimbIK(state.bones, [{ boneId: 'missing', cap: 'foot' }]));
  const creature = fixture(); creature.parts[0].segments = creature.parts[0].segments.slice(0, 1);
  const single = setup(creature); single.ik.goals[0] += 1;
  solveLimbIK(single.bones, single.ik, single.base, single.output);
  near(single.ik.errors[0], 1); lengths(single);
  single.ik.goals[0] = NaN;
  assert.throws(() => solveLimbIK(single.bones, single.ik, single.base, single.output));
});

test('IK deforms the bound skin and returning to rest restores it without meshing again', () => {
  const creature = fixture(), skin = meshField(createField(creature)), rig = createRig(creature, skin);
  const base = createPose(rig.bones), output = createPose(rig.bones); evaluatePose(rig.bones, base);
  const ik = createLimbIK(rig.bones, [{ boneId: 'limb:foot', cap: 'foot' }]), goals = ik.goals.slice();
  const deformed = new Float32Array(skin.positions.length);
  ik.goals[0] += 0.6; ik.goals[1] += 0.3;
  solveLimbIK(rig.bones, ik, base, output); skinPositions(skin.positions, rig.weights, output, deformed);
  assert.ok(deformed.some((value, index) => Math.abs(value - skin.positions[index]) > 0.1));
  ik.goals.set(goals); solveLimbIK(rig.bones, ik, base, output); skinPositions(skin.positions, rig.weights, output, deformed);
  deformed.forEach((value, index) => near(value, skin.positions[index]));
});
