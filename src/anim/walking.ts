import type { Skin } from '../mesh/mesh.ts';
import type { Rig } from '../rig/rig.ts';
import type { Pose } from './pose.ts';
import { createStanding, writeStandingPose, measureContacts, measureBalance } from './standing.ts';
import { createGait, sampleGait, sampleTravelVelocity } from './gait.ts';
import { solveIK } from './ik.ts';
import { mat4 } from 'gl-matrix';
import { evaluatePose } from './pose.ts';

/** Compile contacts at entry. Fixed sole vertices anchor horizontal contact through a cycle. */
export function createWalking(skin: Skin, rig: Rig, floorY: number, output: Pose, tempo = 1) {
  const stance = createStanding(skin, rig);
  writeStandingPose(skin, rig, stance, floorY, output);
  const gait = createGait(rig, stance, tempo);
  const centre = new Float64Array(3);
  for (let foot = 0; foot < stance.contacts.length; foot++) for (const axis of [0, 2]) centre[axis] += stance.contactPositions[foot * 3 + axis] / stance.contacts.length;
  let spread = 0;
  for (let foot = 0; foot < stance.contacts.length; foot++) spread = Math.max(spread, Math.hypot(stance.contactPositions[foot * 3] - centre[0], stance.contactPositions[foot * 3 + 2] - centre[2]));
  const tails = stance.ik.targets.flatMap((target, goal) => {
    let bone = rig.bones.findIndex(bone => bone.id === target.boneId);
    if (target.role !== 'tail' || rig.bones[bone].kind !== 'limb') return [];
    let length = 0;
    while (rig.bones[bone].kind === 'limb' && rig.bones[bone].parent >= 0) {
      const parent = rig.bones[bone].parent, a = rig.bones[bone].restCreature, b = rig.bones[parent].restCreature;
      length += Math.hypot(a[12] - b[12], a[13] - b[13], a[14] - b[14]); bone = parent;
    }
    return [{ goal, length, delay: Math.min(0.3, 0.12 * Math.sqrt(length)) / tempo }];
  });
  return { stance, gait, floorY, baseGoals: stance.ik.goals.slice(), soles: stance.contactPositions.slice(),
    anchors: stance.contactVertices.slice(), actual: new Float64Array(gait.legs.length * 3),
    footOrientations: stance.contacts.map(contact => output.creature[contact.bone].slice()), rotation: new Float32Array(16), inverseParent: new Float32Array(16),
    transfer: { strength: 0, maximumShift: 0.15, centre, spread, offset: new Float64Array(3) },
    body: { strength: 0, headStabilization: 0, centreY: stance.ik.goals[stance.ik.targets.findIndex(target => target.role === 'head') * 3 + 1], offsets: new Float64Array(stance.ik.goals.length) },
    tail: { strength: 0, tails, delayed: new Float64Array(tails.length * 3), offsets: new Float64Array(stance.ik.limbs.goals.length) },
    reaction: { lean: 0, sway: 0, acceleration: new Float64Array(3), velocity: new Float64Array(3) },
    planted: 0, grounded: 0, maximumError: 0 };
}
export type Walking = ReturnType<typeof createWalking>;

/** A planted sole keeps its landing heading in ground space, preserving IK pitch and roll. Position IK
 * alone let the foot rotate with the torso, which looked like dragging in turns.
 * Flight yaw is scheduled alongside the landing position, then contact feedback
 * corrects the skin after this rotation, not before it. Skip a nearly vertical
 * reference axis because its horizontal heading is undefined.
 */
function orientFeet(rig: Rig, walk: Walking, pose: Pose) {
  for (let foot = 0; foot < walk.stance.contacts.length; foot++) {
    const bone = walk.stance.contacts[foot].bone, parent = rig.bones[bone].parent;
    const rest = walk.footOrientations[foot], current = pose.creature[bone];
    const axis = Math.hypot(rest[0], rest[2]) >= Math.hypot(rest[8], rest[10]) ? 0 : 8;
    if (Math.hypot(current[axis], current[axis + 2]) < 1e-6) continue;
    const desired = Math.atan2(-rest[axis + 2], rest[axis]) + walk.gait.footYaw[foot];
    const actual = Math.atan2(-current[axis + 2], current[axis]);
    mat4.fromYRotation(walk.rotation, desired - actual);
    mat4.multiply(walk.rotation, walk.rotation, current);
    for (let axis = 0; axis < 3; axis++) walk.rotation[12 + axis] = pose.creature[bone][12 + axis];
    if (parent < 0) pose.local[bone].set(walk.rotation);
    else {
      mat4.invert(walk.inverseParent, pose.creature[parent]);
      mat4.multiply(pose.local[bone], walk.inverseParent, walk.rotation);
    }
    evaluatePose(rig.bones, pose);
  }
}

export function configureWeightTransfer(walk: Walking, strength: number, maximumShift: number) {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1 || !Number.isFinite(maximumShift) || maximumShift < 0) throw new Error('Weight transfer requires strength in [0, 1] and a nonnegative finite shift limit in metres.');
  walk.transfer.strength = strength; walk.transfer.maximumShift = maximumShift;
}

export function configureBodyMotion(walk: Walking, strength: number) {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Body motion requires strength in [0, 1].');
  walk.body.strength = strength;
}

export function configureHeadStabilization(walk: Walking, strength: number) {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Head stabilization requires strength in [0, 1].');
  walk.body.headStabilization = strength;
}

export function configureTailMotion(walk: Walking, strength: number) {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Tail follow-through requires strength in [0, 1].');
  walk.tail.strength = strength;
}

export function configureMovementReaction(walk: Walking, lean: number, sway: number) {
  if (![lean, sway].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error('Movement reaction strengths must be in [0, 1].');
  walk.reaction.lean = lean; walk.reaction.sway = sway;
}

/** Average acceleration over the previous 180 ms keeps velocity-ramp boundaries
 * continuous. Differencing ground velocity includes centripetal acceleration in
 * turns. Rotate into the current creature frame before posing; no frame history.
 */
function movementReaction(walk: Walking, seconds: number) {
  const { gait, reaction } = walk;
  sampleTravelVelocity(gait, seconds, reaction.acceleration);
  sampleTravelVelocity(gait, seconds - 0.18, reaction.velocity);
  const x = (reaction.acceleration[0] - reaction.velocity[0]) / 0.18;
  const z = (reaction.acceleration[2] - reaction.velocity[2]) / 0.18;
  const c = Math.cos(gait.yaw), s = Math.sin(gait.yaw);
  reaction.acceleration[0] = c * x - s * z;
  reaction.acceleration[2] = s * x + c * z;
}

/** A finite delayed response to authored body motion, sampled from the same
 * command timeline. Three taps soften the lag and finish settling without frame
 * history. Longer tails respond later. This is a motion filter, not physics.
 */
function sampleTailHistory(walk: Walking, seconds: number) {
  const { tail, gait } = walk;
  tail.delayed.fill(0); tail.offsets.fill(0);
  if (!tail.strength || (!walk.body.strength && !walk.reaction.lean)) return;
  for (let index = 0; index < tail.tails.length; index++) {
    const entry = tail.tails[index];
    for (let tap = 1; tap <= 3; tap++) {
      sampleGait(gait, Math.max(0, seconds - entry.delay * tap));
      movementReaction(walk, Math.max(0, seconds - entry.delay * tap));
      bodyMotion(walk);
      const weight = tap === 1 ? 0.5 : tap === 2 ? 0.3 : 0.2;
      for (let axis = 0; axis < 3; axis++) tail.delayed[index * 3 + axis] += walk.body.offsets[entry.goal * 3 + axis] * weight;
    }
  }
}

function tailMotion(walk: Walking) {
  const { tail, body, stance } = walk;
  if (!tail.strength && !walk.reaction.sway) return;
  const spineGoals = stance.ik.targets.length - stance.ik.limbs.goals.length / 3;
  for (let index = 0; index < tail.tails.length; index++) {
    const entry = tail.tails[index], offset = (entry.goal - spineGoals) * 3;
    let distance = 0;
    for (let axis = 0; axis < 3; axis++) {
      const sway = -walk.reaction.sway * entry.length * 0.08 * Math.tanh(walk.reaction.acceleration[axis] / Math.max(0.01, walk.gait.speed * 4));
      const value = (tail.delayed[index * 3 + axis] - body.offsets[entry.goal * 3 + axis]) * tail.strength * 1.5 + sway;
      tail.offsets[offset + axis] = value; distance += value * value;
    }
    distance = Math.sqrt(distance);
    const limit = entry.length * 0.08;
    const scale = distance > 1e-10 && limit > 0 ? limit * Math.tanh(distance / limit) / distance : 0;
    for (let axis = 0; axis < 3; axis++) tail.offsets[offset + axis] *= scale;
  }
}

/** Lower the torso during swing and tilt toward the supporting side. The scheduled
 * lift arc has zero endpoint velocity, so this also settles without a separate clock.
 * All distances are creature-space metres; angles scale with the authored stance.
 */
function bodyMotion(walk: Walking) {
  const { body, gait, soles, transfer, baseGoals, stance } = walk;
  body.offsets.fill(0);
  if ((!body.strength && !walk.reaction.lean) || !gait.legs.length) return;
  let lift = 0, slopeX = 0, slopeZ = 0;
  for (let foot = 0; foot < gait.legs.length; foot++) {
    const height = gait.offsets[foot * 3 + 1];
    lift += height;
    slopeX += height * (soles[foot * 3] - transfer.centre[0]);
    slopeZ += height * (soles[foot * 3 + 2] - transfer.centre[2]);
  }
  const scale = body.strength / gait.legs.length;
  const spreadSquared = transfer.spread * transfer.spread;
  const leanX = walk.reaction.lean * 0.08 * Math.tanh(walk.reaction.acceleration[0] / Math.max(0.01, gait.speed * 4));
  const leanZ = walk.reaction.lean * 0.08 * Math.tanh(walk.reaction.acceleration[2] / Math.max(0.01, gait.speed * 4));
  const rx = (spreadSquared > 1e-10 ? Math.atan(slopeZ / spreadSquared * scale * 0.12) : 0) + leanZ;
  const rz = (spreadSquared > 1e-10 ? -Math.atan(slopeX / spreadSquared * scale * 0.12) : 0) - leanX;
  const cx = Math.cos(rx), sx = Math.sin(rx), cz = Math.cos(rz), sz = Math.sin(rz);
  // Rotate around the standing head height rather than lifting tall creatures through a floor pivot.
  const centreY = body.centreY;
  for (let goal = 0; goal < stance.ik.targets.length; goal++) {
    if (stance.ik.targets[goal].role === 'foot') continue;
    const offset = goal * 3, x = baseGoals[offset] - transfer.centre[0];
    const y = baseGoals[offset + 1] - centreY, z = baseGoals[offset + 2] - transfer.centre[2];
    const tiltedY = cx * y - sx * z, tiltedZ = sx * y + cx * z;
    body.offsets[offset] = cz * x - sz * tiltedY - x + leanX * Math.max(0, centreY - walk.floorY) * 0.3;
    body.offsets[offset + 1] = sz * x + cz * tiltedY - y - lift * scale * 0.25;
    body.offsets[offset + 2] = tiltedZ - z + leanZ * Math.max(0, centreY - walk.floorY) * 0.3;
    // The head already drives the spine solve. Reduce its positional bob and
    // lean goal before IK, leaving the remaining spine goals to shape the body.
    // This does not lock head orientation or assume a separately authored neck.
    if (stance.ik.targets[goal].role === 'head') {
      for (let axis = 0; axis < 3; axis++) body.offsets[offset + axis] *= 1 - body.headStabilization;
    }
  }
}

/** Relative support intent in the translating, turning creature frame. Fixed normalization
 * avoids accelerating the torso when the total support intent is small.
 * Scale by the compiled foot spread so wide stances do not saturate the travel
 * limit early and squeeze the entire direction change into a brief centre crossing.
 */
function weightTransfer(walk: Walking) {
  const { transfer, gait, soles } = walk;
  transfer.offset.fill(0);
  if (!transfer.strength || !transfer.maximumShift || !gait.legs.length) return;
  let x = 0, z = 0;
  for (let foot = 0; foot < gait.legs.length; foot++) {
    const load = gait.loads[foot] - 0.5;
    x += load * (soles[foot * 3] - transfer.centre[0]);
    z += load * (soles[foot * 3 + 2] - transfer.centre[2]);
  }
  // Each centred load is in [-0.5, 0.5], so twice the mean cannot exceed spread.
  x *= 2 / gait.legs.length; z *= 2 / gait.legs.length;
  // A fixed scale bounds travel without distorting the support-intent curve.
  const scale = transfer.spread > 1e-10 ? transfer.strength * Math.min(1, transfer.maximumShift / transfer.spread) : 0;
  transfer.offset[0] = x * scale; transfer.offset[2] = z * scale;
}

function measureAnchors(skin: Skin, rig: Rig, walk: Walking, pose: Pose) {
  for (let foot = 0; foot < walk.anchors.length; foot++) {
    const vertex = walk.anchors[foot], offset = vertex * 3;
    const x = skin.positions[offset], y = skin.positions[offset + 1], z = skin.positions[offset + 2];
    for (let axis = 0; axis < 3; axis++) {
      let value = 0;
      for (let i = rig.weights.offsets[vertex]; i < rig.weights.offsets[vertex + 1]; i++) {
        const matrix = pose.skinning[rig.weights.bones[i]];
        value += rig.weights.values[i] * (matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis]);
      }
      walk.actual[foot * 3 + axis] = value;
    }
  }
}

/** Solve scheduled foot goals in a translating, turning creature frame, on a horizontal floor.
 * Contact feedback corrects skin clearance and horizontal sole drift. Unreachable goals
 * retain a measured residual. No remeshing, history mutation or per-frame buffers.
 */
export function writeWalkingPose(skin: Skin, rig: Rig, walk: Walking, seconds: number, output: Pose) {
  const { gait, stance } = walk;
  sampleTailHistory(walk, seconds);
  sampleGait(gait, seconds);
  movementReaction(walk, seconds);
  weightTransfer(walk);
  bodyMotion(walk);
  tailMotion(walk);
  stance.ik.goals.set(walk.baseGoals);
  for (let goal = 0; goal < stance.ik.targets.length; goal++) if (stance.ik.targets[goal].role !== 'foot') {
    stance.ik.goals[goal * 3] += walk.transfer.offset[0];
    stance.ik.goals[goal * 3 + 2] += walk.transfer.offset[2];
    for (let axis = 0; axis < 3; axis++) stance.ik.goals[goal * 3 + axis] += walk.body.offsets[goal * 3 + axis];
  }
  for (let foot = 0; foot < stance.contacts.length; foot++) {
    const goal = stance.contacts[foot].goal * 3;
    for (let axis = 0; axis < 3; axis++) stance.ik.goals[goal + axis] += gait.offsets[foot * 3 + axis];
  }
  const iterations = walk.body.strength || walk.reaction.lean || walk.reaction.sway || Math.hypot(walk.transfer.offset[0], walk.transfer.offset[2]) > 1e-10 ? 24 : 6;
  for (let iteration = 0; iteration < iterations; iteration++) {
    solveIK(rig.bones, stance.ik, output, walk.tail.offsets);
    orientFeet(rig, walk, output);
    measureContacts(skin, rig, stance, output, walk.floorY);
    measureAnchors(skin, rig, walk, output);
    walk.planted = 0; walk.grounded = 0; walk.maximumError = 0;
    let largest = 0;
    for (let foot = 0; foot < stance.contacts.length; foot++) {
      const offset = foot * 3, goal = stance.contacts[foot].goal * 3;
      const ex = walk.soles[offset] + gait.offsets[offset] - walk.actual[offset];
      const ey = gait.offsets[offset + 1] - stance.gaps[foot];
      const ez = walk.soles[offset + 2] + gait.offsets[offset + 2] - walk.actual[offset + 2];
      const error = Math.hypot(ex, ey, ez);
      largest = Math.max(largest, error);
      if (gait.planted[foot]) {
        walk.planted++;
        if (error <= 0.01) walk.grounded++;
        walk.maximumError = Math.max(walk.maximumError, error);
      }
      // Last measurement must describe the returned pose, including failed reaches.
      if (iteration < iterations - 1 && error >= 0.002) {
        stance.ik.goals[goal] += ex * 0.85;
        stance.ik.goals[goal + 1] += ey * 0.85;
        stance.ik.goals[goal + 2] += ez * 0.85;
      }
    }
    // Give sole feedback six passes before relaxing torso travel. Reach limits
    // take priority over the requested transfer. This continuous reduction avoids
    // choosing between a few discrete shifts as contacts approach their limits.
    if (iteration >= 5 && iteration < iterations - 1 && largest > 0.002) {
      const retain = Math.exp(-40 * (largest - 0.002));
      const dx = walk.transfer.offset[0] * (retain - 1), dz = walk.transfer.offset[2] * (retain - 1);
      walk.transfer.offset[0] *= retain; walk.transfer.offset[2] *= retain;
      for (let goal = 0; goal < stance.ik.targets.length; goal++) if (stance.ik.targets[goal].role !== 'foot') {
        stance.ik.goals[goal * 3] += dx; stance.ik.goals[goal * 3 + 2] += dz;
        for (let axis = 0; axis < 3; axis++) {
          const offset = goal * 3 + axis;
          stance.ik.goals[offset] += walk.body.offsets[offset] * (retain - 1);
          walk.body.offsets[offset] *= retain;
        }
      }
    }
    if (largest < 0.002) break;
  }
  measureBalance(skin, rig, stance, output, walk.floorY, gait.planted);
}
