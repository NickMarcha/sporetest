import type { Bone } from '../rig/skeleton.ts';
import type { Cap } from '../creature/creature.ts';
import type { Pose } from './pose.ts';
import { createPose } from './pose.ts';
import { createLimbIK, solveLimbIK } from './limb-ik.ts';
import { createSpineIK, solveSpineIK } from './spine-ik.ts';

/** Compile semantic targets and both solver phases per rig. Head/tail are ordered spine roles. */
export function createIK(bones: Bone[]) {
  const limbTargets = bones.filter(bone => bone.kind === 'limb' && (bone.cap === 'foot' || bone.cap === 'grasper' || bone.cap === 'tail'))
    .map(bone => ({ boneId: bone.id, cap: bone.cap! }));
  const spine = createSpineIK(bones, limbTargets), limbs = createLimbIK(bones, limbTargets);
  const targets: Array<{ boneId: string; role: 'head' | 'tail' | Cap }> = [{ boneId: bones[spine.head].id, role: 'head' },
    ...(spine.tail === spine.head ? [] : [{ boneId: bones[spine.tail].id, role: 'tail' as const }]),
    ...limbTargets.map(target => ({ boneId: target.boneId, role: target.cap }))];
  const goals = new Float64Array(targets.length * 3);
  targets.forEach((target, index) => goals.set(bones.find(bone => bone.id === target.boneId)!.restCreature.subarray(12, 15), index * 3));
  const spineCount = spine.head === spine.tail ? 1 : 2;
  spine.headGoal = goals.subarray(0, 3);
  spine.tailGoal = goals.subarray((spineCount - 1) * 3, spineCount * 3);
  spine.limbGoals = limbs.goals = goals.subarray(spineCount * 3);
  return { targets, goals, spine, limbs, spinePose: createPose(bones) };
}
export type IK = ReturnType<typeof createIK>;

/** Spine first; freeze its reconstructed pose before solving limbs. No creature mutations. */
export function solveIK(bones: Bone[], ik: IK, output: Pose) {
  solveSpineIK(bones, ik.spine, bones[ik.spine.head].restCreature, ik.spinePose);
  solveLimbIK(bones, ik.limbs, ik.spinePose, output);
}
