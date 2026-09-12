import { mat4, quat, vec3 } from 'gl-matrix';
import type { Bone } from '../rig/skeleton.ts';
import type { Pose } from './pose.ts';
import type { LimbTarget } from './limb-ik.ts';
import { fitSpineCurve, sampleSpineCurve } from './spine-curve.ts';

/** Allocate spine particles only at endpoints and active limb attachments. */
export function createSpineIK(bones: Bone[], targets: LimbTarget[]) {
  const spine = bones.flatMap((bone, index) => bone.kind === 'spine' ? [index] : []);
  if (!spine.length) throw new Error('Spine IK requires a spine.');
  const head = spine[0], tail = spine[spine.length - 1];
  const attachments = targets.map(target => {
    const tip = bones.findIndex(bone => bone.id === target.boneId && bone.cap === target.cap && bone.kind === 'limb');
    if (tip < 0) throw new Error('Spine IK limb target is missing.');
    let parent = tip;
    while (parent >= 0 && bones[parent].kind !== 'spine') parent = bones[parent].parent;
    if (parent < 0) throw new Error('Limb target must attach to the spine.');
    return { tip, parent };
  });
  const particleBones = [...new Set([head, ...attachments.map(item => item.parent), tail])].sort((a, b) => a - b);
  const particleOf = new Int32Array(bones.length).fill(-1);
  particleBones.forEach((bone, index) => { particleOf[bone] = index; });
  const curves = particleBones.slice(1).map((bone, index) => fitSpineCurve(bones,
    spine.slice(spine.indexOf(particleBones[index]), spine.indexOf(bone) + 1)));
  const lengths = Float64Array.from(particleBones.slice(1), (bone, index) => {
    const a = bones[particleBones[index]].restCreature, b = bones[bone].restCreature;
    return Math.hypot(b[12] - a[12], b[13] - a[13], b[14] - a[14]);
  });
  const limbConstraints = attachments.map(({ tip, parent }) => {
    const a = bones[parent].restCreature, b = bones[tip].restCreature;
    return { particle: particleOf[parent], length: Math.hypot(b[12] - a[12], b[13] - a[13], b[14] - a[14]) };
  });
  const limbGoals = new Float64Array(targets.length * 3);
  attachments.forEach(({ tip }, index) => limbGoals.set(bones[tip].restCreature.subarray(12, 15), index * 3));
  return {
    head, tail, particleBones: Int32Array.from(particleBones), particleOf, curves, lengths, limbConstraints,
    headGoal: Float64Array.from(bones[head].restCreature.subarray(12, 15)),
    tailGoal: Float64Array.from(bones[tail].restCreature.subarray(12, 15)),
    limbGoals,
    positions: new Float64Array(particleBones.length * 3), reference: new Float64Array(particleBones.length * 3),
    rotations: particleBones.map(() => quat.create()),
    iterations: 32, tailError: 0, buckling: 0,
    scratch: { a: vec3.create(), b: vec3.create(), c: vec3.create(), position: vec3.create(), tangent: vec3.create(), previous: vec3.create(),
      rotation: quat.create(), frame: quat.create(), orientation: quat.create(), rootRotation: quat.create(),
      rootDelta: mat4.create(), inverse: mat4.create() },
  };
}
export type SpineIK = ReturnType<typeof createSpineIK>;

function tangentAt(positions: Float64Array, index: number, output: vec3) {
  const before = Math.max(0, index - 1) * 3, after = Math.min(positions.length / 3 - 1, index + 1) * 3;
  vec3.set(output, positions[after] - positions[before], positions[after + 1] - positions[before + 1], positions[after + 2] - positions[before + 2]);
  if (vec3.squaredLength(output) < 1e-12) vec3.set(output, 1, 0, 0);
  vec3.normalize(output, output);
}

/**
 * Spine phase, Hecker et al. 4.3.2:
 * https://www.chrishecker.com/Real-time_Motion_Retargeting_to_Highly_Varied_User-Created_Morphologies
 * The head is the FK root. Its goal supplies translation; rootPose supplies orientation.
 * Reduced chord constraints allow 10–120% length; quintic curves reconstruct interior bones.
 * Rest-relative angular anti-buckling and solver gains are our initial tuning, not paper constants.
 */
export function solveSpineIK(bones: Bone[], ik: SpineIK, rootPose: Float32Array, output: Pose) {
  for (let index = 0; index < 3; index++) {
    const goal = index === 0 ? ik.headGoal : index === 1 ? ik.tailGoal : ik.limbGoals;
    for (const value of goal) if (!Number.isFinite(value)) throw new Error('Spine goals must be finite.');
  }
  const { scratch: s, positions: p, reference: reference } = ik;
  mat4.multiply(s.rootDelta, rootPose, bones[ik.head].inverseBind);
  for (let axis = 0; axis < 3; axis++) s.rootDelta[12 + axis] += ik.headGoal[axis] - rootPose[12 + axis];
  mat4.getRotation(s.rootRotation, s.rootDelta); quat.normalize(s.rootRotation, s.rootRotation);
  for (let particle = 0; particle < ik.particleBones.length; particle++) {
    const rest = bones[ik.particleBones[particle]].restCreature;
    vec3.set(s.a, rest[12], rest[13], rest[14]); vec3.transformMat4(s.a, s.a, s.rootDelta);
    for (let axis = 0; axis < 3; axis++) p[particle * 3 + axis] = reference[particle * 3 + axis] = s.a[axis];
  }
  ik.buckling = 0;
  for (let iteration = 0; iteration < ik.iterations; iteration++) {
    // The tail is a positional goal, not another fixed root.
    if (p.length > 3) for (let axis = 0; axis < 3; axis++) p[p.length - 3 + axis] += (ik.tailGoal[axis] - p[p.length - 3 + axis]) * 0.85;
    for (let goal = 0; goal < ik.limbConstraints.length; goal++) {
      const constraint = ik.limbConstraints[goal], offset = constraint.particle * 3;
      if (offset === 0) continue;
      vec3.set(s.a, p[offset] - ik.limbGoals[goal * 3], p[offset + 1] - ik.limbGoals[goal * 3 + 1], p[offset + 2] - ik.limbGoals[goal * 3 + 2]);
      const distance = vec3.length(s.a), allowed = Math.min(constraint.length * 1.2, Math.max(constraint.length * 0.1, distance));
      if (distance > 1e-8) for (let axis = 0; axis < 3; axis++) p[offset + axis] -= s.a[axis] * (distance - allowed) / distance * 0.5;
    }
    for (let constraint = ik.lengths.length - 1; constraint >= 0; constraint--) {
      correctSpineChord(ik, constraint, false);
    }
    for (let particle = 1; particle < ik.particleBones.length - 1; particle++) {
      const offset = particle * 3;
      vec3.set(s.a, p[offset] - p[offset - 3], p[offset + 1] - p[offset - 2], p[offset + 2] - p[offset - 1]);
      vec3.set(s.b, p[offset + 3] - p[offset], p[offset + 4] - p[offset + 1], p[offset + 5] - p[offset + 2]);
      vec3.normalize(s.a, s.a); vec3.normalize(s.b, s.b);
      const posedDot = vec3.dot(s.a, s.b);
      vec3.set(s.a, reference[offset] - reference[offset - 3], reference[offset + 1] - reference[offset - 2], reference[offset + 2] - reference[offset - 1]);
      vec3.set(s.b, reference[offset + 3] - reference[offset], reference[offset + 4] - reference[offset + 1], reference[offset + 5] - reference[offset + 2]);
      vec3.normalize(s.a, s.a); vec3.normalize(s.b, s.b);
      const amount = Math.max(0, Math.min(1, (vec3.dot(s.a, s.b) - posedDot - 0.2) / 0.8));
      const gain = amount * amount * (3 - 2 * amount);
      ik.buckling = Math.max(ik.buckling, gain);
      for (let axis = 0; axis < 3; axis++) p[offset + axis] += (reference[offset + axis] - p[offset + axis]) * (0.015 + 0.35 * gain);
    }
  }
  for (let constraint = 0; constraint < ik.lengths.length; constraint++) correctSpineChord(ik, constraint, true);
  for (let particle = 0; particle < ik.particleBones.length; particle++) {
    tangentAt(reference, particle, s.a); tangentAt(p, particle, s.b);
    quat.rotationTo(s.rotation, s.a, s.b); quat.multiply(ik.rotations[particle], s.rotation, s.rootRotation);
    if (particle === 0) quat.copy(ik.rotations[particle], s.rootRotation);
    const bone = ik.particleBones[particle], matrix = output.creature[bone];
    mat4.fromQuat(s.inverse, ik.rotations[particle]); mat4.multiply(matrix, s.inverse, bones[bone].restCreature);
    for (let axis = 0; axis < 3; axis++) matrix[12 + axis] = p[particle * 3 + axis];
  }
  for (let span = 0; span < ik.curves.length; span++) {
    const curve = ik.curves[span], data = curve.posed;
    for (let axis = 0; axis < 3; axis++) { data[axis] = p[span * 3 + axis]; data[3 + axis] = p[span * 3 + 3 + axis]; }
    const distance = Math.hypot(data[3] - data[0], data[4] - data[1], data[5] - data[2]);
    const scale = ik.lengths[span] > 1e-8 ? distance / ik.lengths[span] : 1;
    for (let derivative = 0; derivative < 4; derivative++) {
      const offset = 6 + derivative * 3;
      vec3.set(s.a, curve.data[offset], curve.data[offset + 1], curve.data[offset + 2]);
      vec3.transformQuat(s.a, s.a, ik.rotations[span + derivative % 2]);
      for (let axis = 0; axis < 3; axis++) data[offset + axis] = s.a[axis] * scale;
    }
    quat.multiply(s.frame, ik.rotations[span], curve.frames[0]);
    sampleSpineCurve(data, 0, s.position, s.previous);
    if (vec3.squaredLength(s.previous) < 1e-12) vec3.set(s.previous, 0, 1, 0);
    vec3.normalize(s.previous, s.previous);
    for (let i = 1; i < curve.indices.length - 1; i++) {
      sampleSpineCurve(data, curve.parameters[i], s.position, s.tangent);
      if (vec3.squaredLength(s.tangent) < 1e-12) vec3.copy(s.tangent, s.previous);
      vec3.normalize(s.tangent, s.tangent); quat.rotationTo(s.rotation, s.previous, s.tangent);
      quat.multiply(s.frame, s.rotation, s.frame); quat.normalize(s.frame, s.frame); vec3.copy(s.previous, s.tangent);
      vec3.transformQuat(s.a, curve.offsets[i], s.frame); vec3.add(s.position, s.position, s.a);
      quat.multiply(s.orientation, s.frame, curve.orientations[i]);
      mat4.fromRotationTranslation(output.creature[curve.indices[i]], s.orientation, s.position);
    }
  }
  // Reconstruct every local matrix before the limb phase, carrying passive attachments.
  for (let index = 0; index < bones.length; index++) {
    const bone = bones[index];
    if (bone.kind === 'limb') {
      output.local[index].set(bone.restLocal);
      mat4.multiply(output.creature[index], output.creature[bone.parent], output.local[index]);
    } else if (bone.parent < 0) output.local[index].set(output.creature[index]);
    else {
      mat4.invert(s.inverse, output.creature[bone.parent]); mat4.multiply(output.local[index], s.inverse, output.creature[index]);
    }
    mat4.multiply(output.skinning[index], output.creature[index], bone.inverseBind);
  }
  ik.tailError = Math.hypot(p[p.length - 3] - ik.tailGoal[0], p[p.length - 2] - ik.tailGoal[1], p[p.length - 1] - ik.tailGoal[2]);
}

function correctSpineChord(ik: SpineIK, constraint: number, outward: boolean) {
  const a = constraint * 3, b = a + 3, p = ik.positions;
  let x = p[b] - p[a], y = p[b + 1] - p[a + 1], z = p[b + 2] - p[a + 2];
  const distance = Math.hypot(x, y, z), length = ik.lengths[constraint];
  const allowed = Math.min(length * 1.2, Math.max(length * 0.1, distance));
  if (Math.abs(distance - allowed) < 1e-10) return;
  if (distance > 1e-8) { x /= distance; y /= distance; z /= distance; }
  else {
    x = ik.reference[b] - ik.reference[a]; y = ik.reference[b + 1] - ik.reference[a + 1]; z = ik.reference[b + 2] - ik.reference[a + 2];
    const referenceLength = Math.hypot(x, y, z);
    if (referenceLength < 1e-8) return;
    x /= referenceLength; y /= referenceLength; z /= referenceLength;
  }
  const proximal = outward || constraint === 0 ? 0 : 0.5, distal = 1 - proximal;
  const correction = distance - allowed;
  p[a] += x * correction * proximal; p[a + 1] += y * correction * proximal; p[a + 2] += z * correction * proximal;
  p[b] -= x * correction * distal; p[b + 1] -= y * correction * distal; p[b + 2] -= z * correction * distal;
}
