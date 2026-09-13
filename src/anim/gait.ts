import type { Rig } from '../rig/rig.ts';
import type { Standing } from './standing.ts';

/** Fixed-speed, straight travel in the authoring frame. Metres and seconds throughout.
 * Leg groups, duty factors and triggers follow Hecker et al. section 4.2:
 * https://www.chrishecker.com/Real-time_Motion_Retargeting_to_Highly_Varied_User-Created_Morphologies
 * Clustering tolerance, rhythm and flight curve are our first walk style.
 */
export function createGait(rig: Rig, stance: Standing) {
  const legs = stance.contacts.map((contact, foot) => {
    let bone = contact.bone, length = 0;
    while (rig.bones[bone].kind === 'limb' && rig.bones[bone].parent >= 0) {
      const parent = rig.bones[bone].parent, a = rig.bones[bone].restCreature, b = rig.bones[parent].restCreature;
      length += Math.hypot(a[12] - b[12], a[13] - b[13], a[14] - b[14]);
      bone = parent;
    }
    return { foot, length: Math.max(0.01, length), hip: bone, group: 0, trigger: 0 };
  });
  legs.sort((a, b) => a.length - b.length);
  const groups: { length: number; feet: number[]; period: number }[] = [];
  for (const leg of legs) {
    let group = groups.at(-1);
    if (!group || leg.length > group.length * 1.2) {
      group = { length: leg.length, feet: [], period: 0 }; groups.push(group);
    }
    group.feet.push(leg.foot); leg.group = groups.length - 1;
  }
  legs.sort((a, b) => a.foot - b.foot);
  const shortest = groups[0]?.length ?? 0;
  for (const group of groups) {
    const ratio = group.length / shortest;
    let rational = 1, error = Infinity;
    for (let denominator = 1; denominator <= 4; denominator++) {
      const candidate = Math.max(1, Math.round(ratio * denominator)) / denominator;
      if (Math.abs(candidate - ratio) < error) { rational = candidate; error = Math.abs(candidate - ratio); }
    }
    group.period = 1.8 * rational;
    let centerX = 0, centerZ = 0;
    for (const foot of group.feet) {
      const position = rig.bones[stance.contacts[foot].bone].restCreature;
      centerX += position[12] / group.feet.length; centerZ += position[14] / group.feet.length;
    }
    // Interleave across the body without relying on authored mirror links or limb insertion order.
    group.feet.sort((a, b) => {
      const pa = rig.bones[stance.contacts[a].bone].restCreature, pb = rig.bones[stance.contacts[b].bone].restCreature;
      return Math.atan2(pa[14] - centerZ, pa[12] - centerX) - Math.atan2(pb[14] - centerZ, pb[12] - centerX) || rig.bones[stance.contacts[a].bone].id.localeCompare(rig.bones[stance.contacts[b].bone].id);
    });
    group.feet.forEach((foot, index) => { legs[foot].trigger = index / group.feet.length; });
  }
  const spine = rig.bones.filter(bone => bone.kind === 'spine');
  const head = spine[0]?.restCreature, tail = spine.at(-1)?.restCreature;
  let dx = head && tail ? head[12] - tail[12] : -1, dz = head && tail ? head[14] - tail[14] : 0;
  const horizontal = Math.hypot(dx, dz);
  if (horizontal < 1e-6) { dx = -1; dz = 0; } else { dx /= horizontal; dz /= horizontal; }
  return { legs, groups, duty: 0.65, speed: shortest * 0.16, direction: new Float64Array([dx, 0, dz]),
    rootTravel: new Float64Array(3), offsets: new Float64Array(legs.length * 3), planted: new Uint8Array(legs.length) };
}
export type Gait = ReturnType<typeof createGait>;

/** Evaluate a steady cycle at elapsed seconds. Offsets are in the translating creature frame.
 * Adding rootTravel recovers fixed authoring-frame contact positions during stance.
 * Absolute time makes sampling deterministic, including scrubbing and skipped frames.
 */
export function sampleGait(gait: Gait, seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Gait time must be finite and non-negative.');
  for (let axis = 0; axis < 3; axis++) gait.rootTravel[axis] = gait.direction[axis] * gait.speed * seconds;
  for (const leg of gait.legs) {
    const period = gait.groups[leg.group].period;
    const phase = ((seconds / period - leg.trigger) % 1 + 1) % 1;
    const stride = gait.speed * period * gait.duty;
    let along: number, lift = 0;
    gait.planted[leg.foot] = phase < gait.duty ? 1 : 0;
    if (phase < gait.duty) along = stride * (0.5 - phase / gait.duty);
    else {
      const flight = (phase - gait.duty) / (1 - gait.duty);
      // Endpoint velocity matches the ground sweep; height has zero endpoint velocity.
      const smooth = flight * flight * (3 - 2 * flight);
      along = -stride / 2 - gait.speed * period * (1 - gait.duty) * flight + gait.speed * period * smooth;
      lift = leg.length * 0.12 * 16 * flight * flight * (1 - flight) * (1 - flight);
    }
    const offset = leg.foot * 3;
    gait.offsets[offset] = gait.direction[0] * along;
    gait.offsets[offset + 1] = lift;
    gait.offsets[offset + 2] = gait.direction[2] * along;
  }
}
