import { mat4, quat, vec3 } from 'gl-matrix';
import type { Bone } from '../rig/skeleton.ts';
import type { Cap } from '../creature/creature.ts';
import type { Pose } from './pose.ts';

/** Goals address semantic caps and stable bones; positions are creature-space metres. */
export type LimbTarget = { boneId: string; cap: Cap };

/** Compile the active limb subtrees once per rig/target selection. The spine phase is separate. */
export function createLimbIK(bones: Bone[], targets: LimbTarget[]) {
  const targetBones = targets.map(target => {
    const index = bones.findIndex(bone => bone.id === target.boneId && bone.cap === target.cap && bone.kind === 'limb');
    if (index < 0) throw new Error('IK target must identify a matching capped limb bone.');
    return index;
  });
  if (new Set(targetBones).size !== targetBones.length) throw new Error('IK targets must be unique.');
  const active = new Set<number>();
  for (let index of targetBones) {
    while (index >= 0 && bones[index].kind === 'limb') { active.add(index); index = bones[index].parent; }
  }
  const particleBones = [...active].sort((a, b) => a - b);
  const particleOf = new Int32Array(bones.length).fill(-1);
  particleBones.forEach((bone, particle) => { particleOf[bone] = particle; });
  const parents = Int32Array.from(particleBones, bone => bones[bone].parent < 0 ? -1 : particleOf[bones[bone].parent]);
  const children = particleBones.map(() => [] as number[]);
  parents.forEach((parent, index) => { if (parent >= 0) children[parent].push(index); });
  const goalParticles = Int32Array.from(targetBones, bone => particleOf[bone]);
  const goalOf = new Int32Array(particleBones.length).fill(-1);
  goalParticles.forEach((particle, goal) => { goalOf[particle] = goal; });
  const constraints = particleBones.flatMap((bone, particle) => {
    const parent = parents[particle];
    if (parent < 0) return [];
    const a = bones[particleBones[parent]].restCreature, b = bones[bone].restCreature;
    return [{ a: parent, b: particle, length: Math.hypot(b[12] - a[12], b[13] - a[13], b[14] - a[14]),
      inverseMassA: parents[parent] < 0 ? 0 : 1, inverseMassB: 1 }];
  });
  // Immediate active children retain their separation at a branch, as in section 4.3.3.
  const crossConstraints = children.flatMap(branch => branch.flatMap((a, index) => branch.slice(index + 1).map(b => {
    const pa = bones[particleBones[a]].restCreature, pb = bones[particleBones[b]].restCreature;
    return { a, b, length: Math.hypot(pa[12] - pb[12], pa[13] - pb[13], pa[14] - pb[14]), inverseMassA: 1, inverseMassB: 1 };
  })));
  const groups: Array<{ anchor: number; particles: number[]; goals: number[] }> = [];
  function group(anchor: number, starts: number[]) {
    const particles: number[] = [], goals: number[] = [];
    function collect(index: number) {
      particles.push(index);
      if (goalOf[index] >= 0) goals.push(goalOf[index]);
      children[index].forEach(collect);
    }
    starts.forEach(collect);
    if (goals.length) groups.push({ anchor, particles, goals });
    function branches(index: number) {
      if (children[index].length > 1 || goalOf[index] >= 0) {
        for (const child of children[index]) group(index, [child]);
      } else children[index].forEach(branches);
    }
    starts.forEach(branches);
  }
  parents.forEach((parent, index) => { if (parent < 0) group(index, children[index]); });
  const positions = new Float64Array(particleBones.length * 3);
  const goals = new Float64Array(targetBones.length * 3);
  targetBones.forEach((bone, index) => goals.set(bones[bone].restCreature.subarray(12, 15), index * 3));
  return {
    particleBones: Int32Array.from(particleBones), particleOf, parents, children, goalParticles, goals, positions,
    constraints, crossConstraints, groups, errors: new Float64Array(targetBones.length),
    iterations: 96,
    // Scratch storage belongs to this solver, never to module globals or the frame loop.
    scratch: { a: vec3.create(), b: vec3.create(), c: vec3.create(), d: vec3.create(), e: vec3.create(),
      rotation: quat.create(), twist: quat.create(), matrix: mat4.create(), inverse: mat4.create() },
  };
}
export type LimbIK = ReturnType<typeof createLimbIK>;

/**
 * Limb phase of Hecker et al., section 4.3.3:
 * https://www.chrishecker.com/Real-time_Motion_Retargeting_to_Highly_Varied_User-Created_Morphologies
 * Aim from the supplied base pose on every call, then nonlinear length correction.
 * This slice uses rigid lengths and positional goals. It does not solve the spine,
 * orientation goals, soft stretch limits, joint limits, collisions, or secondary motion.
 * base and output must be separate; all per-frame buffers are reused.
 */
export function solveLimbIK(bones: Bone[], ik: LimbIK, base: Pose, output: Pose) {
  if (base === output || base.local.length !== bones.length || output.local.length !== bones.length || ik.particleOf.length !== bones.length) {
    throw new Error('IK requires separate matching base and output poses.');
  }
  for (const value of ik.goals) if (!Number.isFinite(value)) throw new Error('IK goals must be finite.');
  const { positions: p, scratch: s } = ik;
  for (let i = 0; i < ik.particleBones.length; i++) {
    const matrix = base.creature[ik.particleBones[i]];
    for (let axis = 0; axis < 3; axis++) p[i * 3 + axis] = matrix[12 + axis];
  }
  for (const group of ik.groups) {
    const anchor = group.anchor * 3;
    vec3.set(s.a, 0, 0, 0); vec3.set(s.b, 0, 0, 0);
    for (const goal of group.goals) for (let axis = 0; axis < 3; axis++) {
      s.a[axis] += (p[ik.goalParticles[goal] * 3 + axis] - p[anchor + axis]) / group.goals.length;
      s.b[axis] += (ik.goals[goal * 3 + axis] - p[anchor + axis]) / group.goals.length;
    }
    const restLength = vec3.length(s.a), goalLength = vec3.length(s.b);
    if (restLength < 1e-8) continue;
    vec3.scale(s.a, s.a, 1 / restLength);
    if (goalLength > 1e-8) vec3.scale(s.b, s.b, 1 / goalLength);
    else vec3.copy(s.b, s.a);
    quat.rotationTo(s.rotation, s.a, s.b);
    const scale = goalLength / restLength;
    for (const particle of group.particles) {
      const offset = particle * 3;
      vec3.set(s.c, p[offset] - p[anchor], p[offset + 1] - p[anchor + 1], p[offset + 2] - p[anchor + 2]);
      vec3.transformQuat(s.c, s.c, s.rotation);
      const along = vec3.dot(s.c, s.b);
      vec3.scaleAndAdd(s.c, s.c, s.b, along * (scale - 1));
      // A perfectly straight compressed chain has no bend direction. Seed a tiny,
      // deterministic perpendicular offset so length correction can leave that singularity.
      if (scale < 0.999 && ik.children[particle].length && along > 1e-8 && along < restLength - 1e-8) {
        vec3.cross(s.d, s.c, s.b);
        if (vec3.squaredLength(s.d) < 1e-12) {
          vec3.set(s.d, Math.abs(s.b[0]) < 0.8 ? 1 : 0, Math.abs(s.b[0]) < 0.8 ? 0 : 1, 0);
          vec3.cross(s.d, s.b, s.d); vec3.normalize(s.d, s.d);
          vec3.scaleAndAdd(s.c, s.c, s.d, 0.05 * restLength * Math.sin(Math.PI * along / restLength));
        }
      }
      for (let axis = 0; axis < 3; axis++) p[offset + axis] = p[anchor + axis] + s.c[axis];
    }
  }
  for (let iteration = 0; iteration < ik.iterations; iteration++) {
    for (let goal = 0; goal < ik.goalParticles.length; goal++) {
      const particle = ik.goalParticles[goal];
      if (ik.parents[particle] < 0) continue;
      for (let axis = 0; axis < 3; axis++) p[particle * 3 + axis] = ik.goals[goal * 3 + axis];
    }
    for (const constraint of ik.crossConstraints) correctLength(ik, base, constraint);
    for (let index = ik.constraints.length - 1; index >= 0; index--) correctLength(ik, base, ik.constraints[index]);
  }
  // Always finish with exact segment lengths. Unreachable/conflicting goals retain
  // a visible residual instead of stretching the skin indefinitely.
  for (const constraint of ik.constraints) {
    const a = constraint.a * 3, b = constraint.b * 3;
    vec3.set(s.a, p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
    if (vec3.squaredLength(s.a) < 1e-16) {
      const ra = base.creature[ik.particleBones[constraint.a]], rb = base.creature[ik.particleBones[constraint.b]];
      vec3.set(s.a, rb[12] - ra[12], rb[13] - ra[13], rb[14] - ra[14]);
    }
    vec3.normalize(s.a, s.a);
    for (let axis = 0; axis < 3; axis++) p[b + axis] = p[a + axis] + s.a[axis] * constraint.length;
  }
  for (let index = 0; index < bones.length; index++) {
    const bone = bones[index], particle = ik.particleOf[index], matrix = output.creature[index];
    if (particle < 0) {
      output.local[index].set(base.local[index]);
      if (bone.parent < 0) matrix.set(output.local[index]);
      else mat4.multiply(matrix, output.creature[bone.parent], output.local[index]);
    } else {
      const children = ik.children[particle];
      if (children.length) {
        const child = children[0], rest = base.creature[index], childRest = base.creature[ik.particleBones[child]];
        vec3.set(s.a, childRest[12] - rest[12], childRest[13] - rest[13], childRest[14] - rest[14]);
        vec3.set(s.b, p[child * 3] - p[particle * 3], p[child * 3 + 1] - p[particle * 3 + 1], p[child * 3 + 2] - p[particle * 3 + 2]);
        quat.identity(s.rotation);
        if (vec3.squaredLength(s.a) > 1e-16 && vec3.squaredLength(s.b) > 1e-16) {
          vec3.normalize(s.a, s.a); vec3.normalize(s.b, s.b); quat.rotationTo(s.rotation, s.a, s.b);
          if (children.length > 1) {
            const second = children[1], secondRest = base.creature[ik.particleBones[second]];
            vec3.set(s.c, secondRest[12] - rest[12], secondRest[13] - rest[13], secondRest[14] - rest[14]);
            vec3.transformQuat(s.c, s.c, s.rotation); vec3.scaleAndAdd(s.c, s.c, s.b, -vec3.dot(s.c, s.b));
            vec3.set(s.d, p[second * 3] - p[particle * 3], p[second * 3 + 1] - p[particle * 3 + 1], p[second * 3 + 2] - p[particle * 3 + 2]);
            vec3.scaleAndAdd(s.d, s.d, s.b, -vec3.dot(s.d, s.b));
            if (vec3.squaredLength(s.c) > 1e-16 && vec3.squaredLength(s.d) > 1e-16) {
              vec3.normalize(s.c, s.c); vec3.normalize(s.d, s.d); vec3.cross(s.e, s.c, s.d);
              quat.setAxisAngle(s.twist, s.b, Math.atan2(vec3.dot(s.b, s.e), vec3.dot(s.c, s.d)));
              quat.multiply(s.rotation, s.twist, s.rotation);
            }
          }
        }
        mat4.fromQuat(s.matrix, s.rotation); mat4.multiply(matrix, s.matrix, base.creature[index]);
      } else if (bone.parent >= 0) mat4.multiply(matrix, output.creature[bone.parent], base.local[index]);
      else matrix.set(base.creature[index]);
      for (let axis = 0; axis < 3; axis++) matrix[12 + axis] = p[particle * 3 + axis];
      if (bone.parent < 0) output.local[index].set(matrix);
      else {
        mat4.invert(s.inverse, output.creature[bone.parent]); mat4.multiply(output.local[index], s.inverse, matrix);
      }
    }
    mat4.multiply(output.skinning[index], matrix, bone.inverseBind);
  }
  for (let goal = 0; goal < ik.goalParticles.length; goal++) {
    const offset = ik.goalParticles[goal] * 3;
    ik.errors[goal] = Math.hypot(p[offset] - ik.goals[goal * 3], p[offset + 1] - ik.goals[goal * 3 + 1], p[offset + 2] - ik.goals[goal * 3 + 2]);
  }
}

function correctLength(ik: LimbIK, base: Pose, constraint: LimbIK['constraints'][number]) {
  const p = ik.positions;
  const a = constraint.a * 3, b = constraint.b * 3;
  let x = p[b] - p[a], y = p[b + 1] - p[a + 1], z = p[b + 2] - p[a + 2];
  const distance = Math.hypot(x, y, z);
  if (distance < 1e-12) {
    if (constraint.length === 0) return;
    const restA = base.creature[ik.particleBones[constraint.a]], restB = base.creature[ik.particleBones[constraint.b]];
    x = restB[12] - restA[12]; y = restB[13] - restA[13]; z = restB[14] - restA[14];
    const restDistance = Math.hypot(x, y, z);
    if (restDistance < 1e-12) return;
    x /= restDistance; y /= restDistance; z /= restDistance;
  } else { x /= distance; y /= distance; z /= distance; }
  const correction = (distance - constraint.length) / (constraint.inverseMassA + constraint.inverseMassB);
  const ca = correction * constraint.inverseMassA, cb = correction * constraint.inverseMassB;
  p[a] += x * ca; p[a + 1] += y * ca; p[a + 2] += z * ca;
  p[b] -= x * cb; p[b + 1] -= y * cb; p[b + 2] -= z * cb;
}
