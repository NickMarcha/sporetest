import type { Skin } from '../mesh/mesh.ts';
import type { Rig } from '../rig/rig.ts';
import type { Pose } from './pose.ts';
import { createStanding, writeStandingPose, measureContacts } from './standing.ts';
import { createGait, sampleGait } from './gait.ts';
import { solveIK } from './ik.ts';

/** Compile contacts at entry. Fixed sole vertices anchor horizontal contact through a cycle. */
export function createWalking(skin: Skin, rig: Rig, floorY: number, output: Pose) {
  const stance = createStanding(skin, rig);
  writeStandingPose(skin, rig, stance, floorY, output);
  const gait = createGait(rig, stance);
  return { stance, gait, floorY, baseGoals: stance.ik.goals.slice(), soles: stance.contactPositions.slice(),
    anchors: stance.contactVertices.slice(), actual: new Float64Array(gait.legs.length * 3),
    planted: 0, grounded: 0, maximumError: 0 };
}
export type Walking = ReturnType<typeof createWalking>;

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

/** Solve scheduled foot goals in a translating creature frame, on a horizontal floor.
 * Contact feedback corrects skin clearance and horizontal sole drift. Unreachable goals
 * retain a measured residual. No remeshing, history mutation or per-frame buffers.
 */
export function writeWalkingPose(skin: Skin, rig: Rig, walk: Walking, seconds: number, output: Pose) {
  const { gait, stance } = walk;
  sampleGait(gait, seconds);
  stance.ik.goals.set(walk.baseGoals);
  for (let foot = 0; foot < stance.contacts.length; foot++) {
    const goal = stance.contacts[foot].goal * 3;
    for (let axis = 0; axis < 3; axis++) stance.ik.goals[goal + axis] += gait.offsets[foot * 3 + axis];
  }
  for (let iteration = 0; iteration < 6; iteration++) {
    solveIK(rig.bones, stance.ik, output);
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
      if (iteration < 5 && error >= 0.002) {
        stance.ik.goals[goal] += ex * 0.85;
        stance.ik.goals[goal + 1] += ey * 0.85;
        stance.ik.goals[goal + 2] += ez * 0.85;
      }
    }
    if (largest < 0.002) break;
  }
}
