import type { Skin } from '../mesh/mesh.ts';
import type { Rig } from '../rig/rig.ts';
import type { Pose } from './pose.ts';

/** A uniform rest-surface mass estimate, not a volume or density model.
 * Collapse area-weighted skinning moments per bone at compile time so measuring
 * the posed centre costs O(bones), rather than skinning the whole creature.
 */
export function createBalance(skin: Skin, rig: Rig) {
  const areas = new Float64Array(skin.positions.length / 3);
  for (let triangle = 0; triangle < skin.triangles.length; triangle += 3) {
    const a = skin.triangles[triangle] * 3, b = skin.triangles[triangle + 1] * 3, c = skin.triangles[triangle + 2] * 3;
    const ux = skin.positions[b] - skin.positions[a], uy = skin.positions[b + 1] - skin.positions[a + 1], uz = skin.positions[b + 2] - skin.positions[a + 2];
    const vx = skin.positions[c] - skin.positions[a], vy = skin.positions[c + 1] - skin.positions[a + 1], vz = skin.positions[c + 2] - skin.positions[a + 2];
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6;
    areas[a / 3] += area; areas[b / 3] += area; areas[c / 3] += area;
  }
  const moments = new Float64Array(rig.bones.length * 4);
  let area = 0;
  for (let vertex = 0; vertex < areas.length; vertex++) {
    area += areas[vertex];
    for (let influence = rig.weights.offsets[vertex]; influence < rig.weights.offsets[vertex + 1]; influence++) {
      const bone = rig.weights.bones[influence] * 4, mass = areas[vertex] * rig.weights.values[influence];
      for (let axis = 0; axis < 3; axis++) moments[bone + axis] += mass * skin.positions[vertex * 3 + axis];
      moments[bone + 3] += mass;
    }
  }
  return { moments, area, centre: new Float64Array(3), nearest: new Float64Array(3),
    points: new Float64Array(skin.positions.length), order: new Uint32Array(areas.length),
    hull: new Uint32Array(areas.length * 2), count: 0, hullCount: 0, supportingFeet: 0,
    available: area > 0, inside: false, distance: Infinity };
}
export type Balance = ReturnType<typeof createBalance>;

function cross(points: Float64Array, a: number, b: number, c: number) {
  return (points[b * 3] - points[a * 3]) * (points[c * 3 + 2] - points[a * 3 + 2])
    - (points[b * 3 + 2] - points[a * 3 + 2]) * (points[c * 3] - points[a * 3]);
}

export function measureCentre(balance: Balance, pose: Pose) {
  balance.centre.fill(0);
  if (!balance.available) return;
  for (let bone = 0; bone < pose.skinning.length; bone++) {
    const matrix = pose.skinning[bone], offset = bone * 4;
    for (let axis = 0; axis < 3; axis++) balance.centre[axis] += (
      matrix[axis] * balance.moments[offset] + matrix[4 + axis] * balance.moments[offset + 1]
      + matrix[8 + axis] * balance.moments[offset + 2] + matrix[12 + axis] * balance.moments[offset + 3]) / balance.area;
  }
}

/** Convex hull of measured foot contacts, projected to the creature-space XZ plane.
 * A monotone-chain hull handles zero, one, two, duplicate and collinear contacts
 * explicitly; they are never promoted to a fictitious support area.
 */
export function measureSupport(balance: Balance, floorY: number) {
  const { points, order, hull, centre } = balance;
  for (let i = 0; i < balance.count; i++) order[i] = i;
  // Shell sort keeps the scratch space fixed and avoids allocating comparator closures or subarrays.
  for (let gap = Math.floor(balance.count / 2); gap > 0; gap = Math.floor(gap / 2)) {
    for (let i = gap; i < balance.count; i++) {
      const value = order[i]; let j = i;
      while (j >= gap) {
        const previous = order[j - gap];
        if (points[previous * 3] < points[value * 3] || (points[previous * 3] === points[value * 3] && points[previous * 3 + 2] <= points[value * 3 + 2])) break;
        order[j] = previous; j -= gap;
      }
      order[j] = value;
    }
  }
  let unique = 0;
  for (let i = 0; i < balance.count; i++) {
    const index = order[i], previous = order[unique - 1];
    if (unique === 0 || points[index * 3] !== points[previous * 3] || points[index * 3 + 2] !== points[previous * 3 + 2]) order[unique++] = index;
  }
  let count = 0;
  for (let i = 0; i < unique; i++) {
    while (count >= 2 && cross(points, hull[count - 2], hull[count - 1], order[i]) <= 0) count--;
    hull[count++] = order[i];
  }
  const lower = count;
  for (let i = unique - 2; i >= 0; i--) {
    while (count > lower && cross(points, hull[count - 2], hull[count - 1], order[i]) <= 0) count--;
    hull[count++] = order[i];
  }
  balance.hullCount = unique > 1 ? count - 1 : count;
  balance.inside = balance.available && balance.hullCount >= 3;
  balance.distance = Infinity;
  balance.nearest.set(centre); balance.nearest[1] = floorY;
  for (let i = 0; i < balance.hullCount; i++) {
    const a = hull[i] * 3, b = hull[(i + 1) % balance.hullCount] * 3;
    const dx = points[b] - points[a], dz = points[b + 2] - points[a + 2];
    const cx = centre[0] - points[a], cz = centre[2] - points[a + 2];
    if (dx * cz - dz * cx < -1e-10) balance.inside = false;
    const length = dx * dx + dz * dz;
    const fraction = length > 0 ? Math.max(0, Math.min(1, (cx * dx + cz * dz) / length)) : 0;
    const x = points[a] + fraction * dx, z = points[a + 2] + fraction * dz;
    const distance = Math.hypot(centre[0] - x, centre[2] - z);
    if (distance < balance.distance) { balance.distance = distance; balance.nearest[0] = x; balance.nearest[2] = z; }
  }
  if (balance.available && balance.distance < 1e-10) balance.inside = true;
  if (balance.inside) { balance.distance = 0; balance.nearest[0] = centre[0]; balance.nearest[2] = centre[2]; }
}
