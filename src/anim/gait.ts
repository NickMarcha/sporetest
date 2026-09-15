import type { Rig } from '../rig/rig.ts';
import type { Standing } from './standing.ts';

/** Cycle duration is seconds for the shortest leg group; lift is a fraction of each leg's length. */
export const defaultGaitSettings = { duty: 0.65, period: 1.8, lift: 0.12 };
export type GaitSettings = typeof defaultGaitSettings;

// A command records a velocity transition in creature-space metres and seconds.
// Keeping commands, rather than frame history, makes backward scrubbing repeatable.
type SettlingStep = { liftOff: number; touchdown: number; fromX: number; fromZ: number; toX: number; toZ: number; fromYaw: number; toYaw: number; height: number };
type FlightRedirect = { fromX: number; fromZ: number; velocityX: number; velocityZ: number; toX: number; toZ: number };
type TravelCommand = { seconds: number; speedSeconds: number; rampSeconds: number; linear: boolean; moving: boolean; distance: number; fromSpeed: number; toSpeed: number; fromSideX: number; fromSideZ: number; toSideX: number; toSideZ: number; x: number; z: number; yaw: number; curvature: number; starts: Float64Array; startTriggers: Float64Array; loads: Float64Array; loadRates: Float64Array; settles: (SettlingStep | null)[]; redirects: (FlightRedirect | null)[]; recoveries: Uint8Array };
const transitionSeconds = 0.6;
/** Seconds reserved to unload a foot before the first step after a start. */
export const preparationSeconds = 0.25;

function smooth(value: number) { const u = Math.max(0, Math.min(1, value)); return u * u * (3 - 2 * u); }
function smoothRate(value: number) { return value > 0 && value < 1 ? 6 * value * (1 - value) : 0; }

function speedIntegral(command: TravelCommand, seconds: number, from = command.fromSpeed, to = command.toSpeed) {
  const elapsed = Math.max(0, seconds - command.speedSeconds), ramp = Math.min(elapsed, command.rampSeconds);
  const u = ramp / command.rampSeconds;
  return from * ramp + (to - from) * command.rampSeconds * (command.linear ? u * u / 2 : u ** 3 - u ** 4 / 2)
    + to * Math.max(0, elapsed - command.rampSeconds);
}

function travelDistance(command: TravelCommand, seconds: number) {
  return command.distance + speedIntegral(command, seconds) - speedIntegral(command, command.seconds);
}

function travelSpeed(command: TravelCommand, seconds: number, from = command.fromSpeed, to = command.toSpeed) {
  const u = Math.min(1, Math.max(0, (seconds - command.speedSeconds) / command.rampSeconds));
  return from + (to - from) * (command.linear ? u : u * u * (3 - 2 * u));
}

/** Ground-space velocity in metres per second, sampled without changing gait state. */
export function sampleTravelVelocity(gait: Gait, seconds: number, output: Float64Array) {
  const command = gait.commands.findLast(command => command.seconds <= seconds);
  output.fill(0);
  if (!command) return;
  const speed = travelSpeed(command, seconds);
  const yaw = command.yaw + command.curvature * (travelDistance(command, seconds) - command.distance);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  output[0] = speed * (c * gait.direction[0] + s * gait.direction[2]) + travelSpeed(command, seconds, command.fromSideX, command.toSideX);
  output[2] = speed * (-s * gait.direction[0] + c * gait.direction[2]) + travelSpeed(command, seconds, command.fromSideZ, command.toSideZ);
}

/** Constant-curvature arc parametrized by travelled metres. Positive yaw turns
 * left about +Y. The midpoint/sinc form also handles straight and tiny turns.
 */
function samplePath(gait: Gait, command: TravelCommand, distance: number, seconds: number, advance: number, output: Float64Array) {
  const travel = distance - command.distance, angle = command.curvature * travel;
  const half = angle / 2, length = travel * (Math.abs(half) < 1e-8 ? 1 - half * half / 6 : Math.sin(half) / half);
  const c = Math.cos(command.yaw + half), s = Math.sin(command.yaw + half);
  // Lateral velocity is stored in ground coordinates so interrupted commands
  // retain velocity even when the facing changes during its deceleration.
  output[0] = command.x + length * (c * gait.direction[0] + s * gait.direction[2])
    + speedIntegral(command, seconds, command.fromSideX, command.toSideX) - speedIntegral(command, command.seconds, command.fromSideX, command.toSideX) + command.toSideX * advance;
  output[1] = 0;
  output[2] = command.z + length * (-s * gait.direction[0] + c * gait.direction[2])
    + speedIntegral(command, seconds, command.fromSideZ, command.toSideZ) - speedIntegral(command, command.seconds, command.fromSideZ, command.toSideZ) + command.toSideZ * advance;
  return command.yaw + angle;
}

function footDestination(gait: Gait, command: TravelCommand, touchdown: number, stanceSeconds: number, foot: number) {
  const distance = travelDistance(command, touchdown) + command.toSpeed * stanceSeconds / 2;
  const yaw = samplePath(gait, command, distance, touchdown, stanceSeconds / 2, gait.pathScratch), c = Math.cos(yaw), s = Math.sin(yaw);
  const x = gait.soles[foot * 3] - gait.pivot[0], z = gait.soles[foot * 3 + 2] - gait.pivot[2];
  gait.pathScratch[0] += gait.pivot[0] + c * x + s * z;
  gait.pathScratch[2] += gait.pivot[2] - s * x + c * z;
  return yaw;
}

/** Travel in the authoring frame. Metres, seconds, and radians about +Y.
 * Leg groups, duty factors and triggers follow Hecker et al. section 4.2:
 * https://www.chrishecker.com/Real-time_Motion_Retargeting_to_Highly_Varied_User-Created_Morphologies
 * Clustering tolerance, rhythm and flight curve are our first walk style.
 * Tempo multiplies cruising speed and divides all default durations by the same
 * amount, preserving step lengths and the spatial path at a faster cadence.
 */
export function createGait(rig: Rig, stance: Standing, tempo = 1) {
  if (!Number.isFinite(tempo) || tempo <= 0) throw new Error('Gait tempo must be positive and finite.');
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
  const groups: { length: number; feet: number[]; period: number; periodRatio: number }[] = [];
  for (const leg of legs) {
    let group = groups.at(-1);
    if (!group || leg.length > group.length * 1.2) {
      group = { length: leg.length, feet: [], period: 0, periodRatio: 1 }; groups.push(group);
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
    group.periodRatio = rational;
    group.period = defaultGaitSettings.period * rational / tempo;
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
  const speed = shortest * 0.16 * tempo;
  const loads = new Float64Array(legs.length).fill(1), loadRates = new Float64Array(legs.length);
  const pivot = new Float64Array(3);
  for (const bone of spine) { pivot[0] += bone.restCreature[12] / spine.length; pivot[2] += bone.restCreature[14] / spine.length; }
  const commands: TravelCommand[] = [{ seconds: 0, speedSeconds: 0, rampSeconds: transitionSeconds / tempo, linear: false, moving: true, distance: 0, fromSpeed: 0, toSpeed: speed, fromSideX: 0, fromSideZ: 0, toSideX: 0, toSideZ: 0, x: 0, z: 0, yaw: 0, curvature: 0, starts: new Float64Array(groups.length).fill(preparationSeconds / tempo), startTriggers: new Float64Array(groups.length), loads: loads.slice(), loadRates: loadRates.slice(), settles: [], redirects: [], recoveries: new Uint8Array(groups.length) }];
  return { legs, groups, tempo, duty: defaultGaitSettings.duty, lift: defaultGaitSettings.lift, speed, commands, currentSideX: 0, currentSideZ: 0,
    moving: true, targetSpeed: speed, currentSpeed: 0, motion: 'starting' as 'starting' | 'accelerating' | 'slowing' | 'walking' | 'stopping' | 'settling' | 'standing', direction: new Float64Array([dx, 0, dz]),
    rootTravel: new Float64Array(3), yaw: 0, curvature: 0, turnRate: 0, targetTurnRate: 0, pivot, soles: stance.contactPositions.slice(), pathScratch: new Float64Array(3),
    offsets: new Float64Array(legs.length * 3), footVelocity: new Float64Array(legs.length * 2), landingPositions: new Float64Array(legs.length * 2), footYaw: new Float64Array(legs.length), planted: new Uint8Array(legs.length), touchdowns: new Float64Array(legs.length), nextLiftOffs: new Float64Array(legs.length), loads, loadRates, settlingRemaining: 0 };
}
export type Gait = ReturnType<typeof createGait>;

/** Apply a steady style without recompiling leg paths or replacing sampling buffers.
 * Changing style resamples absolute time; it does not implement a locomotion transition.
 */
export function configureGait(gait: Gait, settings: GaitSettings) {
  if (!Number.isFinite(settings.duty) || settings.duty <= 0 || settings.duty >= 1) throw new Error('Duty factor must be between zero and one.');
  if (!Number.isFinite(settings.period) || settings.period <= 0) throw new Error('Cycle duration must be positive and finite.');
  if (!Number.isFinite(settings.lift) || settings.lift < 0) throw new Error('Foot lift must be finite and non-negative.');
  gait.duty = settings.duty;
  gait.lift = settings.lift;
  for (const group of gait.groups) group.period = settings.period * group.periodRatio;
}

/** Changing intent after scrubbing replaces future commands, like editing a timeline. */
export function setGaitMoving(gait: Gait, seconds: number, moving: boolean) {
  let speed = gait.speed, sideX = 0, sideZ = 0;
  for (const command of gait.commands) {
    if (command.seconds > seconds) break;
    if (command.moving) { speed = command.toSpeed; sideX = command.toSideX; sideZ = command.toSideZ; }
  }
  setTravelCommand(gait, seconds, moving ? speed : 0, undefined, moving ? sideX : 0, moving ? sideZ : 0, gait.commands.findLast(command => command.seconds <= seconds)?.linear ?? false);
}

/** Forward/left input in the facing frame. Normalize diagonals before applying
 * the requested speed multiplier. Translation changes without rotating the body. */
export function moveGait(gait: Gait, seconds: number, forward: number, left: number, factor = 1, yawDelta = 0) {
  if (![forward, left, factor, yawDelta].every(Number.isFinite) || factor < 0) throw new Error('Movement must be finite with a nonnegative speed factor.');
  sampleGait(gait, seconds);
  const scale = gait.speed * factor / Math.max(1, Math.hypot(forward, left));
  const c = Math.cos(gait.yaw + yawDelta), s = Math.sin(gait.yaw + yawDelta);
  const dx = c * gait.direction[0] + s * gait.direction[2], dz = -s * gait.direction[0] + c * gait.direction[2];
  setTravelCommand(gait, seconds, forward * scale, 0, left * scale * dz, -left * scale * dx, true, yawDelta);
}

/** Signed travel speed in creature-space metres per second; zero requests a stop. */
export function setGaitSpeed(gait: Gait, seconds: number, speed: number) {
  setTravelCommand(gait, seconds, speed);
}

/** Signed metres per second and radians per second at baseline speed. */
export function setGaitDrive(gait: Gait, seconds: number, speed: number, turnRate: number) {
  if (!Number.isFinite(turnRate)) throw new Error('Turn rate must be finite.');
  setTravelCommand(gait, seconds, speed, gait.speed > 0 ? turnRate / gait.speed : 0);
}

/** Radians per second at baseline cruising speed. Turning scales with travel,
 * so stopping holds heading rather than twisting over stationary feet.
 */
export function setGaitTurn(gait: Gait, seconds: number, radiansPerSecond: number) {
  if (!Number.isFinite(radiansPerSecond)) throw new Error('Turn rate must be finite.');
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Gait time must be finite and non-negative.');
  sampleGait(gait, seconds);
  setTravelCommand(gait, seconds, gait.targetSpeed, gait.speed > 0 ? radiansPerSecond / gait.speed : 0);
}

function setTravelCommand(gait: Gait, seconds: number, speed: number, curvature?: number, sideX = 0, sideZ = 0, linear = false, yawDelta = 0) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Gait time must be finite and non-negative.');
  if (!Number.isFinite(speed)) throw new Error('Travel speed must be finite.');
  sampleGait(gait, seconds);
  const x = gait.rootTravel[0], z = gait.rootTravel[2], oldYaw = gait.yaw, yaw = oldYaw + yawDelta, nextCurvature = curvature ?? gait.curvature;
  // Mouse facing changes immediately, but ground velocity must not. Carry the
  // old forward velocity in the lateral ramp until acceleration redirects it.
  const fromSideX = gait.currentSideX + gait.currentSpeed * ((Math.cos(oldYaw) - Math.cos(yaw)) * gait.direction[0] + (Math.sin(oldYaw) - Math.sin(yaw)) * gait.direction[2]);
  const fromSideZ = gait.currentSideZ + gait.currentSpeed * (-(Math.sin(oldYaw) - Math.sin(yaw)) * gait.direction[0] + (Math.cos(oldYaw) - Math.cos(yaw)) * gait.direction[2]);
  const loads = gait.loads.slice(), loadRates = gait.loadRates.slice();
  while (gait.commands.length && gait.commands.at(-1)!.seconds >= seconds) gait.commands.pop();
  const previous = gait.commands.at(-1);
  const moving = speed !== 0 || sideX !== 0 || sideZ !== 0;
  const keepSpeedRamp = yawDelta === 0 && previous?.toSpeed === speed && previous.toSideX === sideX && previous.toSideZ === sideZ && previous.linear === linear;
  if (keepSpeedRamp && previous.curvature === nextCurvature) return;
  // Restart each group on one shared rhythm after retained flights land. Delaying
  // individual origins by their contact times made alternating feet hop together.
  const starts = new Float64Array(gait.groups.length).fill(seconds + preparationSeconds / gait.tempo);
  for (const leg of gait.legs) starts[leg.group] = Math.max(starts[leg.group], gait.touchdowns[leg.foot]);
  const startTriggers = new Float64Array(gait.groups.length);
  for (let groupIndex = 0; groupIndex < gait.groups.length; groupIndex++) {
    const group = gait.groups[groupIndex], stance = group.period * gait.duty, ready = starts[groupIndex];
    let first = group.feet[0];
    for (const foot of group.feet) if (Math.max(ready, gait.touchdowns[foot] + stance) < Math.max(ready, gait.touchdowns[first] + stance)) first = foot;
    startTriggers[groupIndex] = gait.legs[first].trigger;
    for (const foot of group.feet) {
      const phase = (gait.legs[foot].trigger - startTriggers[groupIndex] + 1) % 1;
      starts[groupIndex] = Math.max(starts[groupIndex], gait.touchdowns[foot] + stance - phase * group.period);
    }
  }
  // Player input owns travel. Acceleration is 12 cruising speeds per second,
  // braking 20, independently of the foot schedule. Unlike an ease-in curve,
  // bounded acceleration starts changing velocity immediately.
  // https://github.com/id-Software/Quake-III-Arena/blob/master/code/game/bg_pmove.c
  const change = Math.hypot(speed - gait.currentSpeed, sideX - fromSideX, sideZ - fromSideZ);
  const response = Math.max(1e-6, gait.speed > 0 ? change / (gait.speed * (moving ? 12 : 20)) : 0.05);
  const command: TravelCommand = { seconds, speedSeconds: keepSpeedRamp ? previous.speedSeconds : seconds, rampSeconds: keepSpeedRamp ? previous.rampSeconds : linear ? response : transitionSeconds / gait.tempo, linear, moving, distance: previous ? travelDistance(previous, seconds) : 0,
    fromSideX: keepSpeedRamp ? previous.fromSideX : fromSideX, fromSideZ: keepSpeedRamp ? previous.fromSideZ : fromSideZ, toSideX: sideX, toSideZ: sideZ,
    fromSpeed: keepSpeedRamp ? previous.fromSpeed : previous ? travelSpeed(previous, seconds) : 0, toSpeed: speed, x, z, yaw, curvature: nextCurvature, starts, startTriggers, loads, loadRates, settles: [], redirects: [], recoveries: new Uint8Array(gait.groups.length) };
  gait.commands.push(command);
  if (linear) {
    const c = Math.cos(oldYaw), s = Math.sin(oldYaw);
    for (const leg of gait.legs) {
      if (gait.planted[leg.foot]) continue;
      const offset = leg.foot * 3;
      const fx = gait.soles[offset] + gait.offsets[offset] - gait.pivot[0];
      const fz = gait.soles[offset + 2] + gait.offsets[offset + 2] - gait.pivot[2];
      footDestination(gait, command, gait.touchdowns[leg.foot], gait.groups[leg.group].period * gait.duty, leg.foot);
      // Commit progressively during the last 80 ms so a late input cannot whip
      // the sole sideways just before contact. The next step takes the remainder.
      const blend = smooth((gait.touchdowns[leg.foot] - seconds) / 0.08);
      const landingX = gait.landingPositions[leg.foot * 2], landingZ = gait.landingPositions[leg.foot * 2 + 1];
      command.redirects[leg.foot] = { fromX: x + gait.pivot[0] + c * fx + s * fz, fromZ: z + gait.pivot[2] - s * fx + c * fz,
        velocityX: gait.footVelocity[leg.foot * 2], velocityZ: gait.footVelocity[leg.foot * 2 + 1], toX: landingX + (gait.pathScratch[0] - landingX) * blend, toZ: landingZ + (gait.pathScratch[2] - landingZ) * blend };
    }
  }
  if (linear && moving && previous?.moving) planRecovery(gait, command, oldYaw);
  if (!moving) planSettling(gait, command);
}

/** On changed player intent, advance one group's rhythm when a planted sole
 * strays beyond 32% of leg length from its predicted neutral contact. Keep the
 * group's relative triggers, finish existing flights, and reserve a brief stance
 * before lifting again. This avoids independently advancing feet into a hop.
 */
function planRecovery(gait: Gait, command: TravelCommand, oldYaw: number) {
  let selected = -1, largest = 0.32, selectedReady = 0;
  const lookAhead = command.seconds + 0.08 / gait.tempo;
  const yaw = samplePath(gait, command, travelDistance(command, lookAhead), lookAhead, 0, gait.pathScratch);
  const rootX = gait.pathScratch[0], rootZ = gait.pathScratch[2];
  const c = Math.cos(yaw), s = Math.sin(yaw), oldC = Math.cos(oldYaw), oldS = Math.sin(oldYaw);
  for (const leg of gait.legs) {
    if (!gait.planted[leg.foot]) continue;
    const offset = leg.foot * 3, x = gait.soles[offset] - gait.pivot[0], z = gait.soles[offset + 2] - gait.pivot[2];
    const fx = x + gait.offsets[offset], fz = z + gait.offsets[offset + 2];
    const worldX = command.x + oldC * fx + oldS * fz;
    const worldZ = command.z - oldS * fx + oldC * fz;
    const error = Math.hypot(worldX - rootX - c * x - s * z, worldZ - rootZ + s * x - c * z) / leg.length;
    if (error <= largest) continue;
    const group = gait.groups[leg.group];
    // Advancing one group changes its timing relative to every other group.
    // Only do this when its evenly spaced stance intervals cover a full cycle.
    // Otherwise preserve coordination, especially for one-foot leg groups.
    if (group.feet.length * gait.duty < 1 - 1e-9) continue;
    let ready = command.seconds + 0.04 / gait.tempo;
    for (const foot of group.feet) {
      // A recovery never overlaps an existing flight or immediately relifts a foot.
      ready = Math.max(ready, gait.touchdowns[foot]);
      const phase = (gait.legs[foot].trigger - leg.trigger + 1) % 1;
      ready = Math.max(ready, gait.touchdowns[foot] + group.period * 0.15 - phase * group.period);
    }
    // Keep an earlier pending step. Frequent mouse events must not postpone it.
    if (ready >= gait.nextLiftOffs[leg.foot] - 1e-6) continue;
    selected = leg.foot; largest = error; selectedReady = ready;
  }
  if (selected < 0) return;
  const leg = gait.legs[selected];
  command.recoveries[leg.group] = 1;
  command.starts[leg.group] = selectedReady;
  command.startTriggers[leg.group] = leg.trigger;
}

/** Compile a finite sequence when stopping. Existing flights finish first, then
 * one foot at a time returns to its standing sole position in the final body frame.
 * These are command data, so seeking and restarting during a step remain repeatable.
 */
function planSettling(gait: Gait, command: TravelCommand) {
  let ready = Math.max(command.seconds, command.speedSeconds + command.rampSeconds);
  for (const touchdown of gait.touchdowns) ready = Math.max(ready, touchdown);
  sampleGait(gait, ready);
  const c = Math.cos(gait.yaw), s = Math.sin(gait.yaw);
  let next = ready + preparationSeconds / gait.tempo;
  command.settles = Array<SettlingStep | null>(gait.legs.length).fill(null);
  for (const group of gait.groups) for (const foot of group.feet) {
    const offset = foot * 3, dx = gait.offsets[offset], dz = gait.offsets[offset + 2];
    const distance = Math.hypot(dx, dz);
    const yawError = Math.abs(Math.atan2(Math.sin(gait.footYaw[foot]), Math.cos(gait.footYaw[foot])));
    if (distance <= 0.02 && yawError <= Math.PI / 36) continue;
    const x = gait.soles[offset] - gait.pivot[0], z = gait.soles[offset + 2] - gait.pivot[2];
    const toX = gait.pivot[0] + gait.rootTravel[0] + c * x + s * z;
    const toZ = gait.pivot[2] + gait.rootTravel[2] - s * x + c * z;
    const duration = Math.max(0.35 / gait.tempo, Math.min(0.65 / gait.tempo, group.period * (1 - gait.duty)));
    command.settles[foot] = { liftOff: next, touchdown: next + duration, fromX: toX + c * dx + s * dz, fromZ: toZ - s * dx + c * dz, toX, toZ,
      fromYaw: gait.yaw + gait.footYaw[foot], toYaw: gait.yaw,
      height: Math.min(gait.legs[foot].length * Math.min(gait.lift, 0.06), Math.max(0.025, distance * 0.5)) };
    next += duration + preparationSeconds / gait.tempo;
  }
  sampleGait(gait, command.seconds);
}

/** Sample command history without simulating intervening frames. Feet keep fixed
 * authoring-frame contacts. A stop finishes walking flights before settling steps.
 * Inspection flights retain their lift-off prediction. Player commands may
 * redirect flight landings while retaining position and velocity at the command.
 * Offsets invert root travel and yaw to stay in the translating, turning creature frame.
 */
export function sampleGait(gait: Gait, seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Gait time must be finite and non-negative.');
  let active: TravelCommand | undefined;
  for (const command of gait.commands) { if (command.seconds > seconds) break; active = command; }
  const distance = active ? travelDistance(active, seconds) : 0;
  gait.currentSpeed = active ? travelSpeed(active, seconds) : 0;
  gait.currentSideX = active ? travelSpeed(active, seconds, active.fromSideX, active.toSideX) : 0;
  gait.currentSideZ = active ? travelSpeed(active, seconds, active.fromSideZ, active.toSideZ) : 0;
  gait.targetSpeed = active?.toSpeed ?? 0;
  gait.moving = active?.moving ?? false;
  gait.rootTravel.fill(0);
  gait.yaw = active ? samplePath(gait, active, distance, seconds, 0, gait.rootTravel) : 0;
  gait.curvature = active?.curvature ?? 0;
  gait.turnRate = gait.curvature * gait.currentSpeed; gait.targetTurnRate = gait.curvature * gait.speed;
  const c = Math.cos(gait.yaw), s = Math.sin(gait.yaw);
  let flying = false, settling = false;
  gait.settlingRemaining = 0;
  for (const leg of gait.legs) {
    const period = gait.groups[leg.group].period;
    const flightSeconds = period * (1 - gait.duty), stanceSeconds = period * gait.duty;
    let fromX = gait.soles[leg.foot * 3], fromZ = gait.soles[leg.foot * 3 + 2], toX = fromX, toZ = fromZ;
    let fromYaw = 0, toYaw = 0;
    let liftOff = -Infinity, touchdown = -Infinity;
    let duration = flightSeconds, height = leg.length * gait.lift;
    let horizontalStart = -Infinity, velocityX = 0, velocityZ = 0;
    let cycleOrigin = 0, nextCycle = 0;
    for (let index = 0; index < gait.commands.length; index++) {
      const command = gait.commands[index];
      if (command.seconds > seconds) break;
      const end = gait.commands[index + 1]?.seconds ?? Infinity;
      const redirect = command.redirects[leg.foot];
      if (redirect) {
        fromX = redirect.fromX; fromZ = redirect.fromZ; toX = redirect.toX; toZ = redirect.toZ;
        velocityX = redirect.velocityX; velocityZ = redirect.velocityZ; horizontalStart = command.seconds;
      }
      if (!command.moving) {
        const step = command.settles[leg.foot];
        if (step && step.liftOff <= seconds && step.liftOff < end) {
          fromX = step.fromX; fromZ = step.fromZ; toX = step.toX; toZ = step.toZ;
          fromYaw = step.fromYaw; toYaw = step.toYaw;
          liftOff = step.liftOff; touchdown = step.touchdown; duration = touchdown - liftOff; height = step.height;
          horizontalStart = liftOff; velocityX = velocityZ = 0;
        }
        continue;
      }
      if (!gait.commands[index - 1]?.moving || command.recoveries[leg.group]) {
        cycleOrigin = command.starts[leg.group] + ((leg.trigger - command.startTriggers[leg.group] + 1) % 1) * period;
        nextCycle = 0;
      }
      const first = cycleOrigin + nextCycle * period;
      const limit = Math.min(seconds, end);
      if (first > limit || first >= end) continue;
      let cycle = Math.floor((limit - cycleOrigin) / period);
      if (cycleOrigin + cycle * period >= end) cycle--;
      if (cycle < nextCycle) continue;
      liftOff = cycleOrigin + cycle * period;
      horizontalStart = liftOff; velocityX = velocityZ = 0;
      touchdown = liftOff + flightSeconds;
      duration = flightSeconds; height = leg.length * gait.lift;
      // Earlier completed cycles can be skipped analytically, including after a long seek.
      fromX = toX; fromZ = toZ;
      fromYaw = toYaw;
      if (cycle > nextCycle) {
        fromYaw = footDestination(gait, command, cycleOrigin + (cycle - 1) * period + flightSeconds, stanceSeconds, leg.foot);
        fromX = gait.pathScratch[0]; fromZ = gait.pathScratch[2];
      }
      toYaw = footDestination(gait, command, touchdown, stanceSeconds, leg.foot);
      toX = gait.pathScratch[0]; toZ = gait.pathScratch[2];
      nextCycle = cycle + 1;
    }
    let worldX = toX, worldZ = toZ, worldYaw = toYaw, lift = 0;
    gait.landingPositions[leg.foot * 2] = toX; gait.landingPositions[leg.foot * 2 + 1] = toZ;
    const inFlight = seconds < touchdown;
    gait.touchdowns[leg.foot] = touchdown;
    gait.planted[leg.foot] = inFlight ? 0 : 1;
    gait.footVelocity[leg.foot * 2] = gait.footVelocity[leg.foot * 2 + 1] = 0;
    if (inFlight) {
      flying = true;
      const flight = (seconds - liftOff) / duration;
      const smooth = flight * flight * (3 - 2 * flight);
      // A redirected flight retains its position and velocity at the command.
      // Cubic Hermite reaches the new landing with zero ground-relative velocity.
      const remaining = touchdown - horizontalStart, u = (seconds - horizontalStart) / remaining;
      const blend = u * u * (3 - 2 * u), tangent = u * (1 - u) * (1 - u);
      const blendRate = 6 * u * (1 - u) / remaining, tangentRate = 1 - 4 * u + 3 * u * u;
      worldX = fromX + (toX - fromX) * blend + velocityX * remaining * tangent;
      worldZ = fromZ + (toZ - fromZ) * blend + velocityZ * remaining * tangent;
      gait.footVelocity[leg.foot * 2] = (toX - fromX) * blendRate + velocityX * tangentRate;
      gait.footVelocity[leg.foot * 2 + 1] = (toZ - fromZ) * blendRate + velocityZ * tangentRate;
      worldYaw = fromYaw + Math.atan2(Math.sin(toYaw - fromYaw), Math.cos(toYaw - fromYaw)) * smooth;
      lift = height * 16 * flight * flight * (1 - flight) * (1 - flight);
    }
    const offset = leg.foot * 3;
    gait.footYaw[leg.foot] = worldYaw - gait.yaw;
    const dx = worldX - gait.soles[offset] - gait.rootTravel[0], dz = worldZ - gait.soles[offset + 2] - gait.rootTravel[2];
    const rx = gait.soles[offset] - gait.pivot[0], rz = gait.soles[offset + 2] - gait.pivot[2];
    gait.offsets[offset] = c * dx - s * dz + (c - 1) * rx - s * rz;
    gait.offsets[offset + 1] = lift;
    gait.offsets[offset + 2] = s * dx + c * dz + s * rx + (c - 1) * rz;
    // Continuous support intent, distinct from the binary physical contact flag.
    // Use the whole planted interval for reloading and unloading. A fixed short
    // ramp made slow walks hold each extreme, then rush across to the other side.
    const ramp = stanceSeconds / 2;
    const step = active?.settles[leg.foot];
    const nextLift = gait.moving ? cycleOrigin + nextCycle * period : step && seconds < step.liftOff ? step.liftOff : Infinity;
    if (step && seconds < step.touchdown + ramp) settling = true;
    if (step && seconds < step.touchdown) gait.settlingRemaining++;
    gait.nextLiftOffs[leg.foot] = nextLift;
    const loading = (seconds - touchdown) / ramp, unloading = (nextLift - seconds) / ramp;
    let load = inFlight ? 0 : smooth(loading) * smooth(unloading);
    let rate = inFlight ? 0 : (smoothRate(loading) * smooth(unloading) - smooth(loading) * smoothRate(unloading)) / ramp;
    // Preserve both value and slope when a command cancels anticipated unloading.
    // Snapshots belong to commands, so seeking never depends on previous frames.
    if (active) {
      const elapsed = seconds - active.seconds, u = elapsed / ramp;
      if (u < 1) {
        const blend = smooth(u), blendRate = smoothRate(u) / ramp;
        const from = active.loads[leg.foot] + active.loadRates[leg.foot] * elapsed;
        rate = active.loadRates[leg.foot] * (1 - blend) + rate * blend + (load - from) * blendRate;
        load = from * (1 - blend) + load * blend;
      }
    }
    gait.loads[leg.foot] = Math.max(0, Math.min(1, load));
    gait.loadRates[leg.foot] = load <= 0 || load >= 1 ? 0 : rate;
  }
  const fromSpeed = active ? Math.hypot(active.fromSpeed, active.fromSideX, active.fromSideZ) : 0;
  const toSpeed = active ? Math.hypot(active.toSpeed, active.toSideX, active.toSideZ) : 0;
  gait.motion = gait.moving && gait.legs.length ? (seconds - active!.speedSeconds < active!.rampSeconds
    ? fromSpeed === 0 ? 'starting' : toSpeed > fromSpeed ? 'accelerating' : 'slowing' : 'walking')
    : Math.hypot(gait.currentSpeed, gait.currentSideX, gait.currentSideZ) > 1e-9 ? 'stopping' : settling ? 'settling' : flying ? 'stopping' : 'standing';
}
