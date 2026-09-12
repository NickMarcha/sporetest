import { mat4 } from 'gl-matrix';
import type { Bone } from '../rig/skeleton.ts';
import type { Weights } from '../rig/weights.ts';

/** Preallocated column-major transforms. Nothing here is in renderer world space. */
export function createPose(bones: Bone[]) {
  return {
    local: bones.map(bone => new Float32Array(bone.restLocal)),
    creature: bones.map(() => new Float32Array(16)),
    skinning: bones.map(() => new Float32Array(16)),
  };
}
export type Pose = ReturnType<typeof createPose>;

/** Compose caller-supplied local transforms into creature-space poses and skinning matrices. */
export function evaluatePose(bones: Bone[], pose: Pose) {
  if (pose.local.length !== bones.length) throw new Error('Pose does not match this skeleton.');
  for (let index = 0; index < bones.length; index++) {
    const bone = bones[index];
    if (bone.parent < 0) pose.creature[index].set(pose.local[index]);
    else mat4.multiply(pose.creature[index], pose.creature[bone.parent], pose.local[index]);
    mat4.multiply(pose.skinning[index], pose.creature[index], bone.inverseBind);
  }
}

/** Binding diagnostic, not an action or IK solver. Radians about each bone's local +Z. */
export function writeBendPose(bones: Bone[], radians: number, pose: Pose, limbRadians = 0) {
  if (!Number.isFinite(radians) || !Number.isFinite(limbRadians)) throw new Error('Bend angles must be finite.');
  let length = 0;
  for (const bone of bones) if (bone.kind === 'spine' && bone.parent >= 0) length += Math.hypot(bone.restLocal[12], bone.restLocal[13], bone.restLocal[14]);
  for (let index = 0; index < bones.length; index++) {
    const bone = bones[index];
    const fraction = bone.kind !== 'spine' || bone.parent < 0 || length === 0 ? 0 : Math.hypot(bone.restLocal[12], bone.restLocal[13], bone.restLocal[14]) / length;
    mat4.rotateZ(pose.local[index], bone.restLocal, bone.kind === 'limb' ? limbRadians : radians * fraction);
  }
  evaluatePose(bones, pose);
}

/** CPU reference for headless deformation checks, using the full sparse binding. */
export function skinPositions(positions: Float32Array, weights: Weights, pose: Pose, output: Float32Array) {
  if (output.length !== positions.length) throw new Error('Output must match the skin vertex buffer.');
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const offset = vertex * 3;
    const x = positions[offset], y = positions[offset + 1], z = positions[offset + 2];
    let px = 0, py = 0, pz = 0;
    for (let index = weights.offsets[vertex]; index < weights.offsets[vertex + 1]; index++) {
      const matrix = pose.skinning[weights.bones[index]], weight = weights.values[index];
      px += weight * (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]);
      py += weight * (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]);
      pz += weight * (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]);
    }
    output[offset] = px; output[offset + 1] = py; output[offset + 2] = pz;
  }
}
