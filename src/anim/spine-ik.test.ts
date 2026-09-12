import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mat4, vec3 } from 'gl-matrix';
import { createCreature } from '../creature/creature.ts';
import { createAttachedLimb } from '../creature/attachment.ts';
import { deriveBones } from '../rig/skeleton.ts';
import { createPose, evaluatePose, skinPositions } from './pose.ts';
import { createIK, solveIK } from './ik.ts';
import { fitSpineCurve, sampleSpineCurve } from './spine-curve.ts';
import { solveSpineIK } from './spine-ik.ts';
import { createField } from '../field/field.ts';
import { meshField } from '../mesh/mesh.ts';
import { createRig } from '../rig/rig.ts';

function near(a: number, b: number, tolerance = 2e-5) { assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`); }
function fixture(limbs = false) {
  const creature = createCreature();
  if (limbs) {
    let id = 0;
    for (const z of [0.65, -0.65]) creature.parts.push(createAttachedLimb(creature,
      { position: [0, -0.15, z], normal: [0, 0, Math.sign(z)] }, 'leg', () => `part-${id++}`));
  }
  const bones = deriveBones(creature), ik = createIK(bones), pose = createPose(bones);
  return { creature, bones, ik, pose };
}
function finite(state: ReturnType<typeof fixture>) {
  for (const matrix of state.pose.creature) {
    assert.ok(matrix.every(Number.isFinite)); near(mat4.determinant(matrix), 1, 5e-5);
  }
  const p = state.ik.spine.positions;
  state.ik.spine.lengths.forEach((length, index) => {
    const offset = index * 3;
    const distance = Math.hypot(p[offset + 3] - p[offset], p[offset + 4] - p[offset + 1], p[offset + 5] - p[offset + 2]);
    assert.ok(distance >= length * 0.1 - 1e-5 && distance <= length * 1.2 + 1e-5);
  });
}

test('quintic fitting retains endpoints, derivatives and rest offsets for an inflected spine', () => {
  const creature = createCreature();
  creature.spine = Array.from({ length: 21 }, (_, i) => ({ id: `v${i}`, position: [i / 5, Math.sin(i / 3) * 0.3, Math.cos(i / 4) * 0.2] as [number, number, number], radius: 0.3, orientation: [0, 0, 0, 1] as [number, number, number, number] }));
  const bones = deriveBones(creature), curve = fitSpineCurve(bones, bones.map((_, i) => i));
  const position = vec3.create(), tangent = vec3.create();
  sampleSpineCurve(curve.data, 0, position, tangent);
  for (let axis = 0; axis < 3; axis++) { near(position[axis], curve.data[axis]); near(tangent[axis], curve.data[6 + axis]); }
  sampleSpineCurve(curve.data, 1, position, tangent);
  for (let axis = 0; axis < 3; axis++) { near(position[axis], curve.data[3 + axis]); near(tangent[axis], curve.data[9 + axis]); }
  const ik = createIK(bones), pose = createPose(bones); solveIK(bones, ik, pose);
  assert.equal(ik.spine.particleBones.length, 2);
  pose.creature.forEach((matrix, index) => matrix.forEach((value, axis) => near(value, bones[index].restCreature[axis])));
});

test('rest goals reproduce the skin and compile only endpoints and active attachments', () => {
  const state = fixture(true), before = structuredClone(state.creature);
  solveIK(state.bones, state.ik, state.pose);
  assert.equal(state.ik.spine.particleBones.length, 3);
  state.pose.creature.forEach((matrix, index) => matrix.forEach((value, axis) => near(value, state.bones[index].restCreature[axis])));
  assert.deepEqual(state.creature, before); finite(state);
});

test('head translation is exact while the tail remains a goal and the spine bends', () => {
  const state = fixture();
  state.ik.goals[1] += 0.8;
  solveIK(state.bones, state.ik, state.pose);
  near(state.pose.creature[state.ik.spine.head][13], state.ik.goals[1]);
  assert.ok(state.ik.spine.tailError < 0.002, String(state.ik.spine.tailError));
  assert.ok(Math.abs(state.pose.creature[2][13] - state.bones[2].restCreature[13]) > 0.1);
  finite(state);
});

test('foot targets influence the spine before limbs solve against its frozen pose', () => {
  const state = fixture(true), offset = state.ik.targets.findIndex(target => target.role === 'foot') * 3;
  state.ik.goals[offset] += 1.3;
  solveIK(state.bones, state.ik, state.pose);
  const attachment = state.ik.spine.limbConstraints[0].particle;
  assert.ok(Math.abs(state.ik.spine.positions[attachment * 3] - state.ik.spine.reference[attachment * 3]) > 0.02);
  for (let index = 0; index < state.bones.length; index++) if (state.bones[index].kind === 'spine') {
    state.pose.creature[index].forEach((value, axis) => near(value, state.ik.spinePose.creature[index][axis]));
  }
  for (const constraint of state.ik.limbs.constraints) {
    const a = constraint.a * 3, b = constraint.b * 3, p = state.ik.limbs.positions;
    near(Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]), constraint.length);
  }
  finite(state);
});

test('extreme and conflicting goals obey spine chord bounds and enable anti-buckling', () => {
  const state = fixture(true);
  const root = state.bones[state.ik.spine.head].restCreature;
  // Fold the tail back past the root while the feet remain on the other side.
  state.ik.spine.tailGoal.set([root[12] - 1, root[13], root[14]]);
  solveIK(state.bones, state.ik, state.pose); finite(state);
  assert.ok(state.ik.spine.buckling > 0, String(state.ik.spine.buckling));
  state.ik.spine.tailGoal.set([100, -50, 20]);
  solveIK(state.bones, state.ik, state.pose); finite(state);
  assert.ok(state.ik.spine.tailError > 90);
});

test('one vertebra, coincident endpoints and closed rest curves stay finite', () => {
  for (const count of [1, 3, 5]) {
    const creature = createCreature(); creature.spine = creature.spine.slice(0, count);
    creature.spine.forEach((vertebra, index) => { vertebra.position = count === 5 ? [Math.sin(index * Math.PI / 2), Math.cos(index * Math.PI / 2), 0] : [0, 0, 0]; });
    const bones = deriveBones(creature), ik = createIK(bones), pose = createPose(bones);
    solveIK(bones, ik, pose);
    pose.creature.forEach((matrix, index) => matrix.forEach((value, axis) => near(value, bones[index].restCreature[axis])));
    ik.goals[1] += 0.3; solveIK(bones, ik, pose);
    assert.ok(pose.creature.every(matrix => matrix.every(Number.isFinite)));
    if (count === 1) assert.equal(ik.targets.length, 1);
  }
});

test('pose trajectories reuse buffers, remain path independent and return to rest', () => {
  const state = fixture(true), goals = state.ik.goals.slice(), matrices = state.pose.creature.slice(), positions = state.ik.spine.positions;
  state.ik.goals[1] += 0.4; solveIK(state.bones, state.ik, state.pose);
  const expected = structuredClone(state.pose);
  let previous = state.pose.creature[2][13];
  for (let frame = 0; frame < 120; frame++) {
    state.ik.goals[1] = goals[1] + 0.4 * Math.cos(frame / 20);
    solveIK(state.bones, state.ik, state.pose); finite(state);
    assert.ok(Math.abs(state.pose.creature[2][13] - previous) < 0.1);
    previous = state.pose.creature[2][13];
  }
  state.ik.goals.set(goals); state.ik.goals[1] += 0.4; solveIK(state.bones, state.ik, state.pose);
  assert.deepEqual(state.pose, expected);
  assert.equal(state.ik.spine.positions, positions);
  state.pose.creature.forEach((matrix, index) => assert.equal(matrix, matrices[index]));
  state.ik.goals.set(goals); solveIK(state.bones, state.ik, state.pose);
  state.pose.creature.forEach((matrix, index) => matrix.forEach((value, axis) => near(value, state.bones[index].restCreature[axis])));
});

test('spine reconstruction respects a rotated FK root frame', () => {
  const state = fixture(), transform = mat4.create(); mat4.rotateY(transform, transform, 0.7);
  const root = new Float32Array(16); mat4.multiply(root, transform, state.bones[0].restCreature);
  const point = vec3.create();
  for (const goal of [state.ik.spine.headGoal, state.ik.spine.tailGoal]) {
    vec3.set(point, goal[0], goal[1], goal[2]); vec3.transformMat4(point, point, transform); goal.set(point);
  }
  solveSpineIK(state.bones, state.ik.spine, root, state.pose);
  const matrix = mat4.create();
  state.pose.creature.forEach((actual, index) => {
    mat4.multiply(matrix, transform, state.bones[index].restCreature);
    actual.forEach((value, axis) => near(value, matrix[axis]));
  });
});

test('combined IK moves bound skin and resets without editing or remeshing', () => {
  const state = fixture(true), skin = meshField(createField(state.creature)), rig = createRig(state.creature, skin);
  const output = new Float32Array(skin.positions.length), original = state.ik.goals.slice();
  state.ik.goals[1] += 0.7; solveIK(state.bones, state.ik, state.pose);
  skinPositions(skin.positions, rig.weights, state.pose, output);
  assert.ok(output.some((value, index) => Math.abs(value - skin.positions[index]) > 0.2));
  state.ik.goals.set(original); solveIK(state.bones, state.ik, state.pose);
  skinPositions(skin.positions, rig.weights, state.pose, output);
  output.forEach((value, index) => near(value, skin.positions[index]));
  const reference = createPose(state.bones); evaluatePose(state.bones, reference);
  state.pose.local.forEach((matrix, index) => matrix.forEach((value, axis) => near(value, reference.local[index][axis])));
});
