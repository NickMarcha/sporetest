import type { Skin } from '../mesh/mesh.ts';
import type { Rig } from '../rig/rig.ts';
import type { Pose } from './pose.ts';
import { createIK, solveIK } from './ik.ts';
import { createBalance, measureCentre, measureSupport } from './balance.ts';

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
  return { ik, restGoals: ik.goals.slice(), contacts, bodyBottom, balance: createBalance(skin, rig),
    contactPositions: new Float64Array(contacts.length * 3), contactVertices: new Uint32Array(contacts.length), gaps: new Float64Array(contacts.length),
    correctionGoals: ik.goals.slice(), anchors: new Uint32Array(contacts.length), soles: new Float64Array(contacts.length * 3), baselineGaps: new Float64Array(contacts.length),
    correctionShift: 0, correctionBefore: Infinity, anchorError: 0,
    grounded: 0, maximumError: 0, unsupported: feet.length - contacts.length, bodyShift: 0 };
}
export type Standing = ReturnType<typeof createStanding>;

/** Only skin within one centimetre of the floor under a planted foot supplies
 * support. Torso contact and flight feet are deliberately excluded from this diagnostic.
 */
export function measureBalance(skin: Skin, rig: Rig, stance: Standing, pose: Pose, floorY: number, planted?: Uint8Array) {
  const balance = stance.balance;
  measureCentre(balance, pose);
  balance.count = 0; balance.supportingFeet = 0;
  for (let foot = 0; foot < stance.contacts.length; foot++) {
    if ((planted && !planted[foot]) || Math.abs(stance.gaps[foot]) > 0.01) continue;
    const before = balance.count;
    for (const vertex of stance.contacts[foot].vertices) {
      const offset = vertex * 3, x = skin.positions[offset], y = skin.positions[offset + 1], z = skin.positions[offset + 2];
      let px = 0, py = 0, pz = 0;
      for (let influence = rig.weights.offsets[vertex]; influence < rig.weights.offsets[vertex + 1]; influence++) {
        const matrix = pose.skinning[rig.weights.bones[influence]], weight = rig.weights.values[influence];
        px += weight * (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]);
        py += weight * (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]);
        pz += weight * (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]);
      }
      if (Math.abs(py - floorY) > 0.01) continue;
      const target = balance.count++ * 3;
      balance.points[target] = px; balance.points[target + 1] = floorY; balance.points[target + 2] = pz;
    }
    if (balance.count > before) balance.supportingFeet++;
  }
  measureSupport(balance, floorY);
}

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
 * Optional horizontal torso correction uses the surface-mass support estimate.
 * Run when entering standing or changing its inputs, not on every idle render frame.
 */
export function writeStandingPose(skin: Skin, rig: Rig, stance: Standing, floorY: number, output: Pose, strength = 0, maximumShift = 0.25) {
  if (!Number.isFinite(floorY)) throw new Error('Standing floor height must be finite.');
  if (!Number.isFinite(strength) || strength < 0 || strength > 1 || !Number.isFinite(maximumShift) || maximumShift < 0) throw new Error('Standing correction requires strength in [0, 1] and a nonnegative finite shift limit in metres.');
  const { ik, restGoals } = stance;
  stance.correctionShift = 0; stance.anchorError = 0; stance.correctionBefore = Infinity;
  ik.goals.set(restGoals); stance.bodyShift = 0;
  if (!stance.contacts.length) { solveIK(rig.bones, ik, output); measureBalance(skin, rig, stance, output, floorY); return; }
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
  measureBalance(skin, rig, stance, output, floorY);
  stance.correctionBefore = stance.balance.distance;
  if (strength > 0 && maximumShift > 0 && stance.balance.available && Number.isFinite(stance.balance.distance) && stance.balance.distance > 1e-5) correctSupport(skin, rig, stance, floorY, output, strength, maximumShift);
}

/** Try a bounded torso translation toward the nearest support point. Backtrack
 * when skin contact or support gets worse. Fixed sole vertices prevent a rolling
 * foot from hiding horizontal drift by selecting a different lowest vertex.
 */
function correctSupport(skin: Skin, rig: Rig, stance: Standing, floorY: number, output: Pose, strength: number, maximumShift: number) {
  const { ik, balance, correctionGoals, anchors, soles } = stance;
  correctionGoals.set(ik.goals); anchors.set(stance.contactVertices); soles.set(stance.contactPositions);
  stance.baselineGaps.set(stance.gaps);
  const grounded = stance.grounded;
  const dx = (balance.nearest[0] - balance.centre[0]) / balance.distance;
  const dz = (balance.nearest[2] - balance.centre[2]) / balance.distance;
  let shift = Math.min(maximumShift, balance.distance * strength);
  for (let attempt = 0; attempt < 8; attempt++, shift *= 0.5) {
    ik.goals.set(correctionGoals);
    for (let goal = 0; goal < ik.targets.length; goal++) if (ik.targets[goal].role !== 'foot') {
      ik.goals[goal * 3] += dx * shift; ik.goals[goal * 3 + 2] += dz * shift;
    }
    for (let iteration = 0; iteration < 24; iteration++) {
      solveIK(rig.bones, ik, output); measureContacts(skin, rig, stance, output, floorY);
      stance.anchorError = 0;
      for (let foot = 0; foot < stance.contacts.length; foot++) {
        const vertex = anchors[foot], x = skin.positions[vertex * 3], y = skin.positions[vertex * 3 + 1], z = skin.positions[vertex * 3 + 2];
        let px = 0, pz = 0;
        for (let i = rig.weights.offsets[vertex]; i < rig.weights.offsets[vertex + 1]; i++) {
          const m = output.skinning[rig.weights.bones[i]], w = rig.weights.values[i];
          px += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
          pz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
        }
        const ex = soles[foot * 3] - px, ez = soles[foot * 3 + 2] - pz;
        stance.anchorError = Math.max(stance.anchorError, Math.hypot(ex, ez));
        if (iteration < 23) {
          const goal = stance.contacts[foot].goal * 3;
          ik.goals[goal] += ex * 0.85; ik.goals[goal + 1] -= stance.gaps[foot] * 0.85; ik.goals[goal + 2] += ez * 0.85;
        }
      }
    }
    measureBalance(skin, rig, stance, output, floorY);
    // Allow 0.1 mm numerical change per foot, while retaining the 1 cm contact threshold.
    let contactsPreserved = true;
    for (let foot = 0; foot < stance.contacts.length; foot++) if (Math.abs(stance.gaps[foot]) > Math.abs(stance.baselineGaps[foot]) + 0.0001) contactsPreserved = false;
    if (contactsPreserved && stance.grounded >= grounded && stance.anchorError <= 0.002 && balance.distance < stance.correctionBefore - 1e-5) {
      stance.correctionShift = shift; return;
    }
  }
  ik.goals.set(correctionGoals); solveIK(rig.bones, ik, output);
  measureContacts(skin, rig, stance, output, floorY); measureBalance(skin, rig, stance, output, floorY);
  stance.anchorError = 0;
}
