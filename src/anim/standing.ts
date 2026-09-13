import type { Skin } from '../mesh/mesh.ts';
import type { Rig } from '../rig/rig.ts';
import type { Pose } from './pose.ts';
import { createIK, solveIK } from './ik.ts';

/** Compile sole candidates from the generated skin, rather than treating bone centres as contact points. */
export function createStanding(skin: Skin, rig: Rig) {
  const ik = createIK(rig.bones);
  const feet = ik.targets.flatMap((target, goal) => target.role !== 'foot' ? [] : [{
    bone: rig.bones.findIndex(bone => bone.id === target.boneId), goal, vertices: [] as number[], bottom: Infinity,
  }]);
  let bodyBottom = Infinity;
  for (let vertex = 0; vertex < skin.positions.length / 3; vertex++) {
    let dominant = -1, maximum = -1;
    for (let i = rig.weights.offsets[vertex]; i < rig.weights.offsets[vertex + 1]; i++) {
      if (rig.weights.values[i] > maximum) { maximum = rig.weights.values[i]; dominant = rig.weights.bones[i]; }
    }
    const y = skin.positions[vertex * 3 + 1];
    if (dominant >= 0 && rig.bones[dominant].kind === 'spine') bodyBottom = Math.min(bodyBottom, y);
    const foot = feet.find(foot => foot.bone === dominant);
    if (foot) { foot.vertices.push(vertex); foot.bottom = Math.min(foot.bottom, y); }
  }
  const contacts = feet.filter(foot => foot.vertices.length).map(foot => ({ ...foot, vertices: Uint32Array.from(foot.vertices) }));
  return { ik, restGoals: ik.goals.slice(), contacts, bodyBottom,
    contactPositions: new Float64Array(contacts.length * 3), contactVertices: new Uint32Array(contacts.length), gaps: new Float64Array(contacts.length),
    grounded: 0, maximumError: 0, unsupported: feet.length - contacts.length, bodyShift: 0 };
}
export type Standing = ReturnType<typeof createStanding>;

/** Measure just the compiled foot patches with the same binding as the rendered skin. */
export function measureContacts(skin: Skin, rig: Rig, stance: Standing, pose: Pose, floorY: number) {
  stance.grounded = 0; stance.maximumError = 0;
  for (let foot = 0; foot < stance.contacts.length; foot++) {
    let bottom = Infinity, bx = 0, bz = 0;
    for (const vertex of stance.contacts[foot].vertices) {
      const x = skin.positions[vertex * 3], y = skin.positions[vertex * 3 + 1], z = skin.positions[vertex * 3 + 2];
      let px = 0, py = 0, pz = 0;
      for (let i = rig.weights.offsets[vertex]; i < rig.weights.offsets[vertex + 1]; i++) {
        const m = pose.skinning[rig.weights.bones[i]], w = rig.weights.values[i];
        px += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
        py += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
        pz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
      }
      if (py < bottom) { bottom = py; bx = px; bz = pz; stance.contactVertices[foot] = vertex; }
    }
    stance.contactPositions[foot * 3] = bx; stance.contactPositions[foot * 3 + 1] = floorY; stance.contactPositions[foot * 3 + 2] = bz;
    const gap = bottom - floorY;
    stance.gaps[foot] = gap;
    if (Math.abs(gap) <= 0.01) stance.grounded++;
    stance.maximumError = Math.max(stance.maximumError, Math.abs(gap));
  }
}

/**
 * Static standing controller on a horizontal creature-space floor, in metres.
 * Foot targets retain their authored horizontal placement. The highest rest sole
 * sets initial body height so shorter legs do not start dangling. Contact correction
 * uses posed skin and lowers an overextended body, bounded by rest torso clearance.
 * This is contact placement, not balance, collision response, or a gait.
 * Run when entering standing or changing its inputs, not on every idle render frame.
 */
export function writeStandingPose(skin: Skin, rig: Rig, stance: Standing, floorY: number, output: Pose) {
  if (!Number.isFinite(floorY)) throw new Error('Standing floor height must be finite.');
  const { ik, restGoals } = stance;
  ik.goals.set(restGoals); stance.bodyShift = 0;
  if (!stance.contacts.length) { solveIK(rig.bones, ik, output); return; }
  let highestSole = -Infinity;
  for (const contact of stance.contacts) highestSole = Math.max(highestSole, contact.bottom);
  const minimumShift = Number.isFinite(stance.bodyBottom) ? floorY - stance.bodyBottom : -Infinity;
  stance.bodyShift = Math.max(minimumShift, floorY - highestSole);
  for (let goal = 0; goal < ik.targets.length; goal++) ik.goals[goal * 3 + 1] += stance.bodyShift;
  for (const contact of stance.contacts) ik.goals[contact.goal * 3 + 1] = restGoals[contact.goal * 3 + 1] + floorY - contact.bottom;
  for (let iteration = 0; iteration < 24; iteration++) {
    solveIK(rig.bones, ik, output);
    measureContacts(skin, rig, stance, output, floorY);
    if (stance.maximumError < 0.002) break;
    let highestGap = 0;
    for (let foot = 0; foot < stance.contacts.length; foot++) {
      const gap = stance.gaps[foot];
      ik.goals[stance.contacts[foot].goal * 3 + 1] -= gap * 0.8;
      highestGap = Math.max(highestGap, gap);
    }
    const lower = Math.min(0.08, highestGap * 0.5, stance.bodyShift - minimumShift);
    if (lower > 0) {
      stance.bodyShift -= lower;
      for (let goal = 0; goal < ik.targets.length; goal++) if (ik.targets[goal].role !== 'foot') ik.goals[goal * 3 + 1] -= lower;
    }
  }
  // Goals and diagnostics correspond to the returned pose, including nonconverged cases.
  solveIK(rig.bones, ik, output); measureContacts(skin, rig, stance, output, floorY);
}
