import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCreature } from '../creature/creature.ts';
import { createAttachedLimb } from '../creature/attachment.ts';
import { createField } from '../field/field.ts';
import { meshField } from '../mesh/mesh.ts';
import { createRig } from '../rig/rig.ts';
import { createPose } from './pose.ts';
import { createWalking, writeWalkingPose, configureWeightTransfer, configureBodyMotion, configureTailMotion, configureMovementReaction, configureHeadStabilization } from './walking.ts';
import { sampleGait, configureGait, defaultGaitSettings, preparationSeconds, setGaitMoving, setGaitSpeed, setGaitTurn, setGaitDrive, moveGait } from './gait.ts';
import type { Gait } from './gait.ts';
import { solveIK } from './ik.ts';
import { sampleTravelVelocity } from './gait.ts';

function fixture(count: number, unequal = false, tails = 0) {
  const creature = createCreature(); let id = 0;
  for (let foot = 0; foot < count; foot++) {
    const side = foot % 2 ? -1 : 1;
    const limb = createAttachedLimb(creature, { position: [-0.4 + Math.floor(foot / 2) * 0.8, -0.2, side * 0.65], normal: [0, 0, side] }, 'leg', () => `g${id++}`);
    if (unequal && foot % 2) {
      const root = limb.segments[0].position;
      for (const segment of limb.segments.slice(1)) for (let axis = 0; axis < 3; axis++) segment.position[axis] = root[axis] + (segment.position[axis] - root[axis]) * 0.4;
    }
    creature.parts.push(limb);
  }
  for (let tail = 0; tail < tails; tail++) {
    creature.parts.push(createAttachedLimb(creature, { position: [0.8, 0, tail * 0.3], normal: [1, 0, 0] }, 'tail', () => `t${id++}`));
  }
  const skin = meshField(createField(creature)), rig = createRig(creature, skin), pose = createPose(rig.bones);
  const walk = createWalking(skin, rig, 0, pose);
  return { creature, skin, rig, pose, walk };
}

function groundFoot(gait: Gait, foot: number) {
  const x = gait.soles[foot * 3] + gait.offsets[foot * 3] - gait.pivot[0];
  const z = gait.soles[foot * 3 + 2] + gait.offsets[foot * 3 + 2] - gait.pivot[2];
  const c = Math.cos(gait.yaw), s = Math.sin(gait.yaw);
  return [gait.pivot[0] + gait.rootTravel[0] + c * x + s * z, gait.offsets[foot * 3 + 1], gait.pivot[2] + gait.rootTravel[2] - s * x + c * z];
}

test('head stabilization reduces positional bob and lean without changing travel or foot targets', () => {
  const { skin, rig, walk, pose } = fixture(2);
  configureBodyMotion(walk, 1); configureMovementReaction(walk, 1, 0);
  const headGoal = walk.stance.ik.targets.findIndex(target => target.role === 'head');
  const headBone = rig.bones.findIndex(bone => bone.id === walk.stance.ik.targets[headGoal].boneId);
  let unstabilized = 0, stabilized = 0;
  for (let frame = 1; frame < 90; frame++) {
    const seconds = frame / 30;
    configureHeadStabilization(walk, 0); writeWalkingPose(skin, rig, walk, seconds, pose);
    unstabilized += Math.abs(pose.creature[headBone][13] - walk.baseGoals[headGoal * 3 + 1]);
    const travel = walk.gait.rootTravel.slice(), feet = walk.gait.offsets.slice();
    configureHeadStabilization(walk, 1); writeWalkingPose(skin, rig, walk, seconds, pose);
    stabilized += Math.abs(pose.creature[headBone][13] - walk.baseGoals[headGoal * 3 + 1]);
    assert.deepEqual(walk.gait.rootTravel, travel); assert.deepEqual(walk.gait.offsets, feet);
    assert.ok(walk.maximumError < 0.01);
  }
  assert.ok(unstabilized > 0.01);
  assert.ok(stabilized < unstabilized * 0.1);
  writeWalkingPose(skin, rig, walk, 0.6, pose); const expected = structuredClone(pose);
  writeWalkingPose(skin, rig, walk, 10, pose); writeWalkingPose(skin, rig, walk, 0.6, pose);
  assert.deepEqual(pose, expected);
  assert.throws(() => configureHeadStabilization(walk, NaN));
});

test('mouse facing preserves ground contacts and velocity and can turn at rest', () => {
  const { walk } = fixture(2), gait = walk.gait;
  moveGait(gait, 0, 1, 1); sampleGait(gait, 0.4);
  const position = gait.rootTravel.slice(), feet = gait.legs.map(leg => groundFoot(gait, leg.foot));
  const velocity = new Float64Array(3), after = new Float64Array(3);
  sampleTravelVelocity(gait, 0.4, velocity);
  moveGait(gait, 0.4, 1, 1, 1, 0.1); sampleGait(gait, 0.4);
  assert.deepEqual(gait.rootTravel, position);
  sampleTravelVelocity(gait, 0.4, after);
  after.forEach((value, axis) => assert.ok(Math.abs(value - velocity[axis]) < 1e-9));
  gait.legs.forEach(leg => groundFoot(gait, leg.foot).forEach((value, axis) => assert.ok(Math.abs(value - feet[leg.foot][axis]) < 1e-9)));
  assert.ok(Math.abs(gait.yaw - 0.1) < 1e-9);
  moveGait(gait, 1, 0, 0); sampleGait(gait, 3);
  const stopped = gait.rootTravel.slice();
  moveGait(gait, 3, 0, 0, 1, 0.2); sampleGait(gait, 5);
  assert.deepEqual(gait.rootTravel, stopped);
  assert.ok(Math.abs(gait.yaw - 0.3) < 1e-9);
});

test('movement reaction follows acceleration, opposes braking, and replays without moving the path', () => {
  const { skin, rig, walk, pose } = fixture(2, false, 1);
  configureMovementReaction(walk, 1, 1);
  moveGait(walk.gait, 0, 1, 0);
  writeWalkingPose(skin, rig, walk, 0.06, pose);
  const forward = walk.gait.direction;
  assert.ok(walk.reaction.acceleration[0] * forward[0] + walk.reaction.acceleration[2] * forward[2] > 0);
  // Compare each tail's resolved goal rather than assuming it is the first limb.
  const tail = walk.tail.tails[0];
  const spineGoals = walk.stance.ik.targets.length - walk.stance.ik.limbs.goals.length / 3;
  const offset = (tail.goal - spineGoals) * 3;
  assert.ok(walk.tail.offsets[offset] * forward[0] + walk.tail.offsets[offset + 2] * forward[2] < 0);
  moveGait(walk.gait, 0.5, 0, 0);
  writeWalkingPose(skin, rig, walk, 0.53, pose);
  assert.ok(walk.reaction.acceleration[0] * forward[0] + walk.reaction.acceleration[2] * forward[2] < 0);
  writeWalkingPose(skin, rig, walk, 0.75, pose);
  assert.ok(walk.reaction.acceleration.every(value => Math.abs(value) < 1e-9));
  setGaitMoving(walk.gait, 1, true); setGaitTurn(walk.gait, 1, 0.2);
  for (let frame = 0; frame < 90; frame++) {
    writeWalkingPose(skin, rig, walk, frame / 30, pose);
    assert.ok(walk.maximumError < 0.01, `movement reaction contact error ${walk.maximumError}`);
  }
  writeWalkingPose(skin, rig, walk, 2, pose);
  assert.ok(Math.hypot(...walk.reaction.acceleration) > 0.001, 'curved steady travel has centripetal acceleration');
  const expected = structuredClone(pose), travel = walk.gait.rootTravel.slice();
  writeWalkingPose(skin, rig, walk, 10, pose); writeWalkingPose(skin, rig, walk, 2, pose);
  assert.deepEqual(pose, expected);
  configureMovementReaction(walk, 0, 0); writeWalkingPose(skin, rig, walk, 2, pose);
  assert.deepEqual(walk.gait.rootTravel, travel);
  assert.throws(() => configureMovementReaction(walk, -1, 0));
});

test('attached tails follow body motion, settle, preserve contact and replay', () => {
  const { skin, rig, walk, pose } = fixture(2, false, 2);
  configureBodyMotion(walk, 1); configureTailMotion(walk, 1);
  assert.equal(walk.tail.tails.length, 2, 'spine tail is not an attached tail');
  const offsets = walk.tail.offsets;
  let moved = false;
  for (let frame = 0; frame < 100; frame++) {
    writeWalkingPose(skin, rig, walk, frame / 30, pose);
    assert.ok(walk.maximumError < 0.01);
    assert.ok(offsets.every(Number.isFinite));
    moved ||= offsets.some(value => Math.abs(value) > 1e-4);
  }
  assert.ok(moved);
  const goals = walk.stance.ik.goals.slice();
  solveIK(rig.bones, walk.stance.ik, pose);
  const spine = structuredClone(walk.stance.ik.spinePose);
  solveIK(rig.bones, walk.stance.ik, pose, offsets);
  assert.deepEqual(walk.stance.ik.spinePose, spine, 'tail follow-through must not drive the spine');
  assert.deepEqual(walk.stance.ik.goals, goals, 'secondary motion must not change authored pose goals');
  writeWalkingPose(skin, rig, walk, 1.2, pose); const expected = structuredClone(pose);
  writeWalkingPose(skin, rig, walk, 10, pose);
  writeWalkingPose(skin, rig, walk, 1.2, pose); assert.deepEqual(pose, expected);
  setGaitMoving(walk.gait, 3, false);
  writeWalkingPose(skin, rig, walk, 20, pose);
  assert.ok(offsets.every(value => Math.abs(value) < 1e-10));
  configureTailMotion(walk, 0); writeWalkingPose(skin, rig, walk, 1.2, pose);
  assert.ok(offsets.every(value => value === 0));
  configureTailMotion(walk, 1); configureBodyMotion(walk, 0);
  writeWalkingPose(skin, rig, walk, 1.2, pose);
  assert.ok(offsets.every(value => value === 0));
  assert.equal(walk.tail.offsets, offsets);
  assert.throws(() => configureTailMotion(walk, Infinity));
});

test('body motion follows steps, preserves contacts, settles and replays', () => {
  for (const count of [0, 1, 2, 4]) {
    const { skin, rig, walk, pose } = fixture(count);
    const offsets = walk.body.offsets;
    configureBodyMotion(walk, 1);
    let moved = false;
    for (let frame = 0; frame < 120; frame++) {
      writeWalkingPose(skin, rig, walk, frame / 30, pose);
      assert.ok(offsets.every(Number.isFinite));
      assert.ok(walk.maximumError < 0.01, `contact error with ${count} feet: ${walk.maximumError}`);
      moved ||= offsets.some(value => Math.abs(value) > 1e-4);
    }
    assert.equal(moved, count > 0);
    writeWalkingPose(skin, rig, walk, 0.6, pose); const expected = structuredClone(pose);
    writeWalkingPose(skin, rig, walk, 8, pose);
    writeWalkingPose(skin, rig, walk, 0.6, pose); assert.deepEqual(pose, expected);
    setGaitMoving(walk.gait, 4, false);
    writeWalkingPose(skin, rig, walk, 30, pose);
    assert.ok(offsets.every(value => Math.abs(value) < 1e-10));
    configureBodyMotion(walk, 0);
    writeWalkingPose(skin, rig, walk, 0.6, pose);
    assert.ok(offsets.every(value => value === 0));
    assert.equal(walk.body.offsets, offsets);
    assert.throws(() => configureBodyMotion(walk, NaN));
  }
});

test('threefold tempo preserves walking and settling poses at three times travel speed', () => {
  const { walk, skin, rig, pose } = fixture(2);
  const fastPose = createPose(rig.bones), fast = createWalking(skin, rig, 0, fastPose, 3);
  assert.equal(fast.gait.speed, walk.gait.speed * 3);
  for (const [time, moving] of [[2.1, false], [2.7, true], [5.3, false]] as const) {
    setGaitMoving(walk.gait, time, moving); setGaitMoving(fast.gait, time / 3, moving);
  }
  for (let frame = 0; frame < 240; frame++) {
    const time = (frame + 0.1) / 30;
    writeWalkingPose(skin, rig, walk, time, pose); writeWalkingPose(skin, rig, fast, time / 3, fastPose);
    assert.deepEqual(fast.gait.planted, walk.gait.planted);
    fast.gait.rootTravel.forEach((value, axis) => assert.ok(Math.abs(value - walk.gait.rootTravel[axis]) < 1e-8));
    for (let bone = 0; bone < pose.creature.length; bone++) fastPose.creature[bone].forEach((value, axis) => assert.ok(Math.abs(value - pose.creature[bone][axis]) < 1e-4));
    assert.ok(fast.maximumError < 0.01);
  }
});

test('strafing keeps facing, normalizes diagonals and supports arbitrary foot counts', () => {
  for (const count of [0, 1, 2, 4, 7]) {
    const { walk } = fixture(count);
    for (const [forward, left] of [[0, 1], [0, -1], [1, 0], [1, 1], [-1, -1]]) {
      const gait = structuredClone(walk.gait);
      moveGait(gait, 0, forward, left); sampleGait(gait, 2);
      assert.equal(gait.yaw, 0);
      assert.ok(Math.abs(Math.hypot(...gait.rootTravel) - gait.speed * (2 - 1 / 24)) < 1e-8, 'Diagonal travel must not be faster');
      if (forward === 0) assert.ok(Math.abs(gait.rootTravel[0] * gait.direction[0] + gait.rootTravel[2] * gait.direction[2]) < 1e-8);
      assert.ok(gait.offsets.every(Number.isFinite));
    }
  }
});

test('fast strafe changes redirect flights continuously and preserve contact and replay', () => {
  const { skin, rig } = fixture(2), pose = createPose(rig.bones), walk = createWalking(skin, rig, 0, pose, 3), gait = walk.gait;
  moveGait(gait, 0, 0, 1);
  for (const [time, forward, left] of [[0.45, 1, 1], [0.85, 0, -1], [1.3, -1, 0], [1.75, 0, 0]]) {
    sampleGait(gait, time); const before = structuredClone(gait);
    moveGait(gait, time, forward, left); sampleGait(gait, time);
    assert.deepEqual(gait.rootTravel, before.rootTravel);
    assert.equal(gait.currentSpeed, before.currentSpeed);
    assert.equal(gait.currentSideX, before.currentSideX); assert.equal(gait.currentSideZ, before.currentSideZ);
    for (const leg of gait.legs) if (!before.planted[leg.foot]) {
      groundFoot(gait, leg.foot).forEach((value, axis) => assert.ok(Math.abs(value - groundFoot(before, leg.foot)[axis]) < 1e-8));
      for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(gait.footVelocity[leg.foot * 2 + axis] - before.footVelocity[leg.foot * 2 + axis]) < 1e-8);
      assert.equal(gait.touchdowns[leg.foot], before.touchdowns[leg.foot]);
    }
  }
  for (let frame = 0; frame < 240; frame++) {
    writeWalkingPose(skin, rig, walk, frame / 60, pose);
    assert.ok(walk.planted > 0, `No support at ${frame / 60}`);
    assert.ok(walk.maximumError < 0.01, `Strafe contact error ${walk.maximumError} at ${frame / 60}`);
    assert.equal(gait.yaw, 0);
  }
  assert.equal(gait.motion, 'standing');
  writeWalkingPose(skin, rig, walk, 0.65, pose); const expected = structuredClone(pose);
  writeWalkingPose(skin, rig, walk, 8, pose); writeWalkingPose(skin, rig, walk, 0.65, pose); assert.deepEqual(pose, expected);
});

test('player movement accelerates immediately and brakes independently of the gait cycle', () => {
  const { walk } = fixture(2), gait = walk.gait;
  moveGait(gait, 0, 1, 0);
  sampleGait(gait, 1 / 120);
  assert.ok(Math.abs(gait.currentSpeed / gait.speed - 0.1) < 1e-9);
  sampleGait(gait, 1 / 12);
  assert.equal(gait.currentSpeed, gait.speed);
  moveGait(gait, 0.2, 0, 1);
  sampleGait(gait, 0.2 + Math.SQRT2 / 12);
  assert.ok(Math.abs(gait.currentSpeed) < 1e-9);
  assert.ok(Math.abs(Math.hypot(gait.currentSideX, gait.currentSideZ) - gait.speed) < 1e-9);
  moveGait(gait, 0.4, 0, 0); sampleGait(gait, 0.4); const start = gait.rootTravel.slice();
  sampleGait(gait, 0.45);
  assert.ok(Math.hypot(gait.currentSpeed, gait.currentSideX, gait.currentSideZ) < 1e-9);
  assert.ok(Math.abs(Math.hypot(...gait.rootTravel.map((value, axis) => value - start[axis])) - gait.speed * 0.025) < 1e-9);
  const end = gait.rootTravel.slice(); sampleGait(gait, 3); assert.deepEqual(gait.rootTravel, end);
});

test('player redirection remains continuous near touchdown and after repeated input changes', () => {
  const { skin, rig } = fixture(2), pose = createPose(rig.bones);
  for (const time of [0.09, 0.16, 0.28, 0.29, 0.292, 0.39]) {
    const walk = createWalking(skin, rig, 0, pose, 3), gait = walk.gait;
    moveGait(gait, 0, 1, 0);
    sampleGait(gait, time); const before = structuredClone(gait);
    moveGait(gait, time, 0, -1); sampleGait(gait, time);
    for (const leg of gait.legs) {
      groundFoot(gait, leg.foot).forEach((value, axis) => assert.ok(Math.abs(value - groundFoot(before, leg.foot)[axis]) < 1e-8));
      for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(gait.footVelocity[leg.foot * 2 + axis] - before.footVelocity[leg.foot * 2 + axis]) < 1e-8);
    }
    moveGait(gait, time + 0.03, -1, 0); moveGait(gait, time + 0.08, 0, 0); moveGait(gait, time + 0.1, 0, 1);
    for (let frame = 0; frame < 120; frame++) {
      writeWalkingPose(skin, rig, walk, frame / 120, pose);
      assert.ok(walk.planted > 0);
      assert.ok(Number.isFinite(walk.maximumError)); // Rapid reversals may exceed the fixed stance reach; the residual must remain observable.
    }
  }
});

test('left and right turns follow circular paths and zero turn retains straight travel', () => {
  const { walk } = fixture(2), gait = walk.gait;
  for (const rate of [-0.2, 0.2]) {
    setGaitTurn(gait, 0, rate);
    const seconds = 0.3 + Math.PI / (2 * Math.abs(rate));
    sampleGait(gait, seconds);
    const radius = gait.speed / Math.abs(rate), sign = Math.sign(rate);
    assert.ok(Math.abs(gait.yaw - sign * Math.PI / 2) < 1e-9);
    assert.ok(Math.abs(gait.rootTravel[0] - radius * (gait.direction[0] + sign * gait.direction[2])) < 1e-9);
    assert.ok(Math.abs(gait.rootTravel[2] - radius * (gait.direction[2] - sign * gait.direction[0])) < 1e-9);
  }
  setGaitTurn(gait, 0, 0); sampleGait(gait, 5);
  const straight = gait.rootTravel.slice();
  setGaitTurn(gait, 0, 1e-12); sampleGait(gait, 5);
  gait.rootTravel.forEach((value, axis) => assert.ok(Math.abs(value - straight[axis]) < 1e-9));
  const before = structuredClone(gait.commands);
  for (const rate of [NaN, Infinity]) assert.throws(() => setGaitTurn(gait, 1, rate));
  assert.deepEqual(gait.commands, before);
});

test('steering preserves planted ground contacts, existing flights, heading and replay', () => {
  const { walk } = fixture(4, true), gait = walk.gait;
  setGaitTurn(gait, 0, 0.15);
  sampleGait(gait, 0.4);
  const previous = structuredClone(gait), yaw = gait.yaw, root = gait.rootTravel.slice();
  const contacts = gait.legs.map(leg => groundFoot(gait, leg.foot));
  setGaitTurn(gait, 0.4, -0.2); sampleGait(gait, 0.4);
  assert.equal(gait.yaw, yaw); assert.deepEqual(gait.rootTravel, root);
  for (let frame = 0; frame < 10; frame++) {
    const time = 0.4 + frame / 100;
    sampleGait(gait, time); sampleGait(previous, time);
    assert.equal(gait.currentSpeed, previous.currentSpeed, 'steering must not restart an acceleration ramp');
    for (const leg of gait.legs) {
      const actual = groundFoot(gait, leg.foot);
      const expected = previous.planted[leg.foot] ? contacts[leg.foot] : groundFoot(previous, leg.foot);
      actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-9));
    }
  }
  setGaitMoving(gait, 2, false); sampleGait(gait, 10);
  const stoppedYaw = gait.yaw, stoppedRoot = gait.rootTravel.slice();
  sampleGait(gait, 100); assert.equal(gait.yaw, stoppedYaw); assert.deepEqual(gait.rootTravel, stoppedRoot);
  sampleGait(gait, 1.5); const expected = structuredClone(gait);
  sampleGait(gait, 50); sampleGait(gait, 1.5);
  assert.deepEqual(gait, expected);
  setGaitTurn(gait, 0.3, 0);
  assert.deepEqual(gait.commands.map(command => command.seconds), [0, 0.3]);
});

test('gentle turning keeps measured planted soles within one centimetre', () => {
  for (const count of [2, 4]) {
    const { walk, skin, rig, pose, creature } = fixture(count), before = structuredClone(creature);
    configureWeightTransfer(walk, 1, 0.15);
    setGaitTurn(walk.gait, 0, Math.PI / 36);
    for (let frame = 0; frame < 120; frame++) {
      writeWalkingPose(skin, rig, walk, frame / 30, pose);
      assert.ok(walk.maximumError < 0.01, `${count} feet at ${frame / 30}: ${walk.maximumError}`);
      assert.ok(pose.creature.every(matrix => matrix.every(Number.isFinite)));
    }
    writeWalkingPose(skin, rig, walk, 0.5, pose); const expected = structuredClone(pose);
    writeWalkingPose(skin, rig, walk, 10, pose); writeWalkingPose(skin, rig, walk, 0.5, pose);
    assert.deepEqual(pose, expected); assert.deepEqual(creature, before);
  }
});

test('arbitrary foot counts have distinct triggers, finite motion, and planted targets fixed relative to the ground', () => {
  for (const count of [0, 1, 2, 3, 7]) {
    const { walk } = fixture(count), gait = walk.gait;
    assert.equal(gait.legs.length, count);
    for (const group of gait.groups) assert.equal(new Set(group.feet.map(foot => gait.legs[foot].trigger)).size, group.feet.length);
    for (const leg of gait.legs) {
      const period = gait.groups[leg.group].period;
      sampleGait(gait, preparationSeconds + period * (leg.trigger + 1 - gait.duty + gait.duty * 0.1));
      assert.equal(gait.planted[leg.foot], 1);
      const x = gait.offsets[leg.foot * 3] + gait.rootTravel[0], z = gait.offsets[leg.foot * 3 + 2] + gait.rootTravel[2];
      sampleGait(gait, preparationSeconds + period * (leg.trigger + 1 - gait.duty + gait.duty * 0.9));
      assert.equal(gait.planted[leg.foot], 1);
      assert.ok(Math.abs(gait.offsets[leg.foot * 3] + gait.rootTravel[0] - x) < 1e-9);
      assert.ok(Math.abs(gait.offsets[leg.foot * 3 + 2] + gait.rootTravel[2] - z) < 1e-9);
      sampleGait(gait, preparationSeconds + period * (leg.trigger + (1 - gait.duty) / 2));
      assert.equal(gait.planted[leg.foot], 0);
      assert.ok(gait.offsets[leg.foot * 3 + 1] > 0);
    }
    assert.ok(gait.offsets.every(Number.isFinite));
    assert.throws(() => sampleGait(gait, NaN));
    assert.throws(() => sampleGait(gait, -1));
  }
});

test('flight joins stance continuously in position and velocity', () => {
  const { walk } = fixture(2), gait = walk.gait, epsilon = 1e-5;
  for (const leg of gait.legs) for (const boundary of [1 - gait.duty, 1]) {
    const time = preparationSeconds + gait.groups[leg.group].period * (leg.trigger + boundary);
    sampleGait(gait, time - epsilon); const before = gait.offsets.slice(leg.foot * 3, leg.foot * 3 + 3);
    sampleGait(gait, time); const at = gait.offsets.slice(leg.foot * 3, leg.foot * 3 + 3);
    sampleGait(gait, time + epsilon);
    for (let axis = 0; axis < 3; axis++) {
      const after = gait.offsets[leg.foot * 3 + axis];
      assert.ok(Math.abs(after - before[axis]) < 1e-4);
      assert.ok(Math.abs((after - at[axis]) / epsilon - (at[axis] - before[axis]) / epsilon) < 0.001);
    }
  }
});

test('different leg lengths form harmonized groups with slower cycles for longer legs', () => {
  const { walk } = fixture(4, true), groups = walk.gait.groups;
  assert.ok(groups.length > 1);
  for (const group of groups) {
    const ratio = group.period / groups[0].period;
    assert.ok([1, 2, 3, 4].some(denominator => Math.abs(ratio * denominator - Math.round(ratio * denominator)) < 1e-9));
  }
  assert.ok(groups.at(-1)!.period > groups[0].period);
});

test('tuning preserves group rhythms, fixed planted targets and deterministic sampling', () => {
  for (const count of [0, 4]) {
    const { walk } = fixture(count, true), gait = walk.gait;
    const offsets = gait.offsets, planted = gait.planted, travel = gait.rootTravel;
    const ratios = gait.groups.map(group => group.period / gait.groups[0].period);
    for (const settings of [{ duty: 0.2, period: 0.6, lift: 0 }, { duty: 0.9, period: 4, lift: 0.4 }, defaultGaitSettings]) {
      configureGait(gait, settings);
      gait.groups.forEach((group, index) => assert.ok(Math.abs(group.period - settings.period * ratios[index]) < 1e-9));
      for (const leg of gait.legs) {
        const period = gait.groups[leg.group].period, offset = leg.foot * 3;
        sampleGait(gait, preparationSeconds + period * (leg.trigger + 1 - settings.duty + settings.duty * 0.1));
        const x = gait.offsets[offset] + gait.rootTravel[0], z = gait.offsets[offset + 2] + gait.rootTravel[2];
        sampleGait(gait, preparationSeconds + period * (leg.trigger + 1 - settings.duty + settings.duty * 0.9));
        assert.equal(gait.planted[leg.foot], 1);
        assert.ok(Math.abs(gait.offsets[offset] + gait.rootTravel[0] - x) < 1e-9);
        assert.ok(Math.abs(gait.offsets[offset + 2] + gait.rootTravel[2] - z) < 1e-9);
        sampleGait(gait, preparationSeconds + period * (leg.trigger + (1 - settings.duty) / 2));
        assert.equal(gait.planted[leg.foot], 0);
        assert.ok(Math.abs(gait.offsets[offset + 1] - leg.length * settings.lift) < 1e-9);
      }
      sampleGait(gait, 0.37); const expected = gait.offsets.slice();
      sampleGait(gait, 99); sampleGait(gait, 0.37);
      assert.deepEqual(gait.offsets, expected);
    }
    assert.equal(gait.offsets, offsets); assert.equal(gait.planted, planted); assert.equal(gait.rootTravel, travel);
    for (const settings of [
      { ...defaultGaitSettings, duty: 0 }, { ...defaultGaitSettings, duty: 1 },
      { ...defaultGaitSettings, duty: NaN }, { ...defaultGaitSettings, period: 0 },
      { ...defaultGaitSettings, period: Infinity }, { ...defaultGaitSettings, lift: -1 },
      { ...defaultGaitSettings, lift: NaN },
    ]) {
      const before = structuredClone(gait);
      assert.throws(() => configureGait(gait, settings));
      assert.deepEqual(gait, before);
    }
  }
});

test('a tuned walking pose can be scrubbed backward and restored after changing style', () => {
  const { skin, rig, walk, pose, creature } = fixture(2), before = structuredClone(creature);
  const settings = { duty: 0.75, period: 2.4, lift: 0.18 };
  configureGait(walk.gait, settings);
  writeWalkingPose(skin, rig, walk, 0.37, pose);
  const expected = structuredClone(pose);
  writeWalkingPose(skin, rig, walk, 30, pose);
  configureGait(walk.gait, defaultGaitSettings);
  writeWalkingPose(skin, rig, walk, 5, pose);
  configureGait(walk.gait, settings);
  writeWalkingPose(skin, rig, walk, 0.37, pose);
  assert.deepEqual(pose, expected);
  assert.deepEqual(creature, before);
});

test('walking skin contacts stay planted across a cycle, with reused buffers and no authored edits', () => {
  const state = fixture(2), { walk } = state, before = structuredClone(state.creature);
  const matrices = state.pose.local.slice(), goals = walk.stance.ik.goals, actual = walk.actual;
  let maximum = 0;
  for (let frame = 0; frame <= 90; frame++) {
    writeWalkingPose(state.skin, state.rig, walk, frame / 50, state.pose);
    maximum = Math.max(maximum, walk.maximumError);
    assert.ok(state.pose.creature.every(matrix => matrix.every(Number.isFinite)));
  }
  assert.ok(maximum < 0.01, `Maximum planted skin error ${maximum} m`);
  writeWalkingPose(state.skin, state.rig, walk, 0.37, state.pose); const expected = structuredClone(state.pose);
  writeWalkingPose(state.skin, state.rig, walk, 10, state.pose);
  writeWalkingPose(state.skin, state.rig, walk, 0.37, state.pose);
  assert.deepEqual(state.pose, expected);
  assert.deepEqual(state.creature, before);
  assert.equal(walk.stance.ik.goals, goals); assert.equal(walk.actual, actual);
  state.pose.local.forEach((matrix, index) => assert.equal(matrix, matrices[index]));
});

test('starts accelerate from rest and stops preserve planted ground contacts while flights finish', () => {
  for (const count of [0, 1, 2, 7]) {
    const { walk } = fixture(count, true), gait = walk.gait;
    sampleGait(gait, 0);
    assert.ok(gait.offsets.every(value => value === 0));
    assert.equal(gait.currentSpeed, 0);
    sampleGait(gait, 0.3);
    assert.ok(Math.abs(gait.currentSpeed - gait.speed / 2) < 1e-10);
    const before = gait.offsets.slice(), root = gait.rootTravel.slice(), planted = gait.planted.slice();
    setGaitMoving(gait, 0.3, false);
    sampleGait(gait, 0.3);
    assert.deepEqual(gait.offsets, before);
    assert.deepEqual(gait.rootTravel, root);
    assert.deepEqual(gait.planted, planted);
    for (let frame = 1; frame <= 60; frame++) {
      sampleGait(gait, 0.3 + frame / 30);
      for (const leg of gait.legs) if (planted[leg.foot]) {
        assert.equal(gait.planted[leg.foot], 1, 'a stop must not launch a planted foot');
        for (const axis of [0, 2]) assert.ok(Math.abs(gait.offsets[leg.foot * 3 + axis] + gait.rootTravel[axis] - before[leg.foot * 3 + axis] - root[axis]) < 1e-9);
      }
    }
    sampleGait(gait, 10);
    assert.equal(gait.motion, 'standing');
    assert.equal(gait.currentSpeed, 0);
    assert.ok(gait.planted.every(value => value === 1));
    const stopped = gait.offsets.slice(), stoppedRoot = gait.rootTravel.slice();
    sampleGait(gait, 1000);
    assert.deepEqual(gait.offsets, stopped); assert.deepEqual(gait.rootTravel, stoppedRoot);
  }
});

test('rapid stop/start commands preserve position and velocity, including in-flight goals', () => {
  const { walk } = fixture(4, true), gait = walk.gait, epsilon = 1e-6;
  for (const [seconds, moving] of [[0.2, false], [0.3, true], [0.42, false], [1.1, true], [3, false]] as const) {
    sampleGait(gait, seconds - epsilon);
    const before = gait.offsets.slice(), beforeRoot = gait.rootTravel.slice();
    sampleGait(gait, seconds);
    const at = gait.offsets.slice(), atRoot = gait.rootTravel.slice(), speed = gait.currentSpeed;
    setGaitMoving(gait, seconds, moving);
    sampleGait(gait, seconds);
    assert.deepEqual(gait.offsets, at); assert.deepEqual(gait.rootTravel, atRoot);
    assert.equal(gait.currentSpeed, speed);
    sampleGait(gait, seconds + epsilon);
    for (let index = 0; index < at.length; index++) {
      assert.ok(Math.abs((at[index] - before[index]) / epsilon - (gait.offsets[index] - at[index]) / epsilon) < 0.001);
    }
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs((atRoot[axis] - beforeRoot[axis]) / epsilon - (gait.rootTravel[axis] - atRoot[axis]) / epsilon) < 0.001);
  }
  const commands = structuredClone(gait.commands);
  sampleGait(gait, 0.37); const expected = gait.offsets.slice();
  sampleGait(gait, 99); sampleGait(gait, 0.37);
  assert.deepEqual(gait.offsets, expected); assert.deepEqual(gait.commands, commands);
  setGaitMoving(gait, 0.25, true);
  assert.deepEqual(gait.commands.map(command => command.seconds), [0, 0.2, 0.25]);
  for (const seconds of [-1, NaN, Infinity]) assert.throws(() => setGaitMoving(gait, seconds, false));
});

test('stopping skin contact settles and replaying the command timeline reproduces the pose', () => {
  const { skin, rig, pose, walk, creature } = fixture(2), before = structuredClone(creature);
  setGaitMoving(walk.gait, 0.25, false);
  setGaitMoving(walk.gait, 2, true);
  setGaitMoving(walk.gait, 4.1, false);
  let maximum = 0;
  for (let frame = 0; frame <= 360; frame++) {
    writeWalkingPose(skin, rig, walk, frame / 30, pose);
    maximum = Math.max(maximum, walk.maximumError);
    assert.ok(pose.creature.every(matrix => matrix.every(Number.isFinite)));
  }
  assert.ok(maximum < 0.01, `Maximum planted skin error ${maximum} m`);
  assert.equal(walk.gait.motion, 'standing');
  const settled = structuredClone(pose);
  writeWalkingPose(skin, rig, walk, 20, pose);
  assert.deepEqual(pose, settled);
  writeWalkingPose(skin, rig, walk, 0.4, pose); const expected = structuredClone(pose);
  writeWalkingPose(skin, rig, walk, 5, pose); writeWalkingPose(skin, rig, walk, 0.4, pose);
  assert.deepEqual(pose, expected); assert.deepEqual(creature, before);
});

test('speed changes retain foot timing and in-flight endpoints while root speed ramps continuously', () => {
  const { walk } = fixture(4, true), gait = walk.gait, original = structuredClone(gait);
  for (const [seconds, factor] of [[0.2, 2], [0.35, 0.5], [1.8, 1.5]] as const) {
    sampleGait(gait, seconds);
    const offsets = gait.offsets.slice(), root = gait.rootTravel.slice(), speed = gait.currentSpeed;
    const prior = structuredClone(gait);
    setGaitSpeed(gait, seconds, gait.speed * factor);
    sampleGait(gait, seconds);
    assert.deepEqual(gait.offsets, offsets); assert.deepEqual(gait.rootTravel, root);
    assert.equal(gait.currentSpeed, speed);
    sampleGait(gait, seconds + 0.3);
    assert.ok(Math.abs(gait.currentSpeed - (speed + gait.speed * factor) / 2) < 1e-9);
    // Existing flights have fixed endpoints. Compare their authoring-frame paths
    // until the original touchdown, even though the body's trajectory changed.
    for (let frame = 1; frame <= 10; frame++) {
      const time = seconds + frame / 100;
      sampleGait(gait, time); sampleGait(prior, time);
      for (const leg of gait.legs) if (prior.planted[leg.foot] === 0) {
        const period = gait.groups[leg.group].period;
        const phaseAtCommand = (((seconds - preparationSeconds) / period - leg.trigger) % 1 + 1) % 1;
        if (phaseAtCommand < 1e-9 || phaseAtCommand >= 1 - gait.duty) continue;
        for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(gait.offsets[leg.foot * 3 + axis] + gait.rootTravel[axis]
          - prior.offsets[leg.foot * 3 + axis] - prior.rootTravel[axis]) < 1e-9, `Flight changed at command ${seconds}, sample ${time}, foot ${leg.foot}, axis ${axis}`);
      }
    }
  }
  for (let frame = 0; frame < 150; frame++) {
    sampleGait(gait, frame / 30); sampleGait(original, frame / 30);
    assert.deepEqual(gait.planted, original.planted, `changing speed must not restart the step schedule at ${frame / 30}s`);
  }
  sampleGait(gait, 3);
  assert.ok(Math.abs(gait.currentSpeed - gait.speed * 1.5) < 1e-9);
  setGaitSpeed(gait, 3, 0); sampleGait(gait, 20);
  assert.equal(gait.motion, 'standing');
  setGaitMoving(gait, 20, true); sampleGait(gait, 21);
  assert.equal(gait.targetSpeed, gait.speed * 1.5, 'restart resumes the last nonzero speed');
  const before = structuredClone(gait.commands);
  for (const speed of [NaN, Infinity]) assert.throws(() => setGaitSpeed(gait, 2, speed));
  assert.deepEqual(gait.commands, before);
});

test('support intent unloads before lift and stays continuous through commands and step boundaries', () => {
  const { walk, skin, rig, pose } = fixture(2), gait = walk.gait, epsilon = 1e-6;
  sampleGait(gait, 0);
  assert.ok(gait.planted.every(Boolean)); assert.ok(gait.loads.every(load => load === 1));
  sampleGait(gait, preparationSeconds / 2);
  const first = gait.legs.find(leg => leg.trigger === 0)!.foot;
  assert.equal(gait.planted[first], 1);
  assert.ok(gait.loads[first] > 0 && gait.loads[first] < 1);
  configureWeightTransfer(walk, 1, 0.15);
  writeWalkingPose(skin, rig, walk, preparationSeconds / 2, pose);
  assert.ok(walk.transfer.offset[0] * (walk.soles[first * 3] - walk.transfer.centre[0])
    + walk.transfer.offset[2] * (walk.soles[first * 3 + 2] - walk.transfer.centre[2]) < 0, 'torso moves away from the foot about to lift');
  for (const seconds of [preparationSeconds, preparationSeconds + 1.8 * (1 - gait.duty), preparationSeconds + 1.8]) {
    sampleGait(gait, seconds - epsilon); const before = gait.loads.slice();
    sampleGait(gait, seconds); const at = gait.loads.slice();
    sampleGait(gait, seconds + epsilon);
    at.forEach((value, foot) => assert.ok(Math.abs((value - before[foot]) / epsilon - (gait.loads[foot] - value) / epsilon) < 0.001));
  }
  for (const [seconds, factor] of [[0.12, 0], [0.2, 1], [0.3, 2], [1.05, 0], [1.15, 1]] as const) {
    sampleGait(gait, seconds - epsilon); const before = gait.loads.slice();
    sampleGait(gait, seconds); const at = gait.loads.slice();
    setGaitSpeed(gait, seconds, gait.speed * factor);
    sampleGait(gait, seconds); assert.deepEqual(gait.loads, at);
    sampleGait(gait, seconds + epsilon);
    at.forEach((value, foot) => assert.ok(Math.abs((value - before[foot]) / epsilon - (gait.loads[foot] - value) / epsilon) < 0.001));
  }
});

test('weight transfer handles mixed leg groups and all-foot flight without a support singularity', () => {
  for (const count of [2, 7]) {
    const { walk, skin, rig, pose } = fixture(count, count === 7);
    configureWeightTransfer(walk, 1, 0.3);
    configureGait(walk.gait, { duty: 0.2, period: 1.8, lift: 0.12 });
    for (const seconds of [0, 0.1, 0.25, 1, 2.1, 20, 0.1]) {
      writeWalkingPose(skin, rig, walk, seconds, pose);
      assert.ok(walk.transfer.offset.every(Number.isFinite));
      assert.ok(Math.hypot(...walk.transfer.offset) <= 0.3);
      assert.ok(pose.creature.every(matrix => matrix.every(Number.isFinite)));
      if (count === 2 && seconds === 2.1) {
        assert.ok(walk.gait.planted.every(value => value === 0));
        assert.ok(walk.transfer.offset.every(value => Math.abs(value) < 1e-10));
      }
    }
  }
});

test('weight transfer is bounded, preserves planted soles, and replays without frame history', () => {
  for (const count of [0, 1, 2, 4]) {
    const { walk, skin, rig, pose, creature } = fixture(count), before = structuredClone(creature);
    const offsets = walk.transfer.offset, loads = walk.gait.loads;
    configureWeightTransfer(walk, 1, 0.15);
    let moved = false;
    for (let frame = 0; frame < 100; frame++) {
      writeWalkingPose(skin, rig, walk, frame / 30, pose);
      const distance = Math.hypot(...walk.transfer.offset);
      moved ||= distance > 0.001;
      assert.ok(distance <= 0.15);
      assert.ok(walk.maximumError < 0.01, `${count} feet at ${frame / 30}: ${walk.maximumError}`);
      assert.ok(walk.gait.loads.every(load => Number.isFinite(load) && load >= 0 && load <= 1));
      assert.ok(pose.creature.every(matrix => matrix.every(Number.isFinite)));
    }
    assert.equal(moved, count > 1);
    for (const leg of walk.gait.legs) for (const boundary of [0, 1 - walk.gait.duty, 1]) {
      const seconds = preparationSeconds + walk.gait.groups[leg.group].period * (leg.trigger + boundary);
      writeWalkingPose(skin, rig, walk, seconds - 1e-6, pose); const before = walk.transfer.offset.slice();
      writeWalkingPose(skin, rig, walk, seconds + 1e-6, pose);
      assert.ok(Math.hypot(...walk.transfer.offset.map((value, axis) => value - before[axis])) < 0.0001, `torso discontinuity at ${seconds}`);
    }
    setGaitMoving(walk.gait, 0.12, false); setGaitMoving(walk.gait, 0.4, true); setGaitMoving(walk.gait, 2.2, false);
    writeWalkingPose(skin, rig, walk, 0.6, pose); const expected = structuredClone(pose);
    writeWalkingPose(skin, rig, walk, 30, pose);
    assert.ok(walk.transfer.offset.every(value => Math.abs(value) < 1e-10));
    writeWalkingPose(skin, rig, walk, 0.6, pose); assert.deepEqual(pose, expected);
    assert.equal(walk.transfer.offset, offsets); assert.equal(walk.gait.loads, loads);
    assert.deepEqual(creature, before);
    configureWeightTransfer(walk, 0, 0.15); writeWalkingPose(skin, rig, walk, 0.6, pose);
    const baseline = structuredClone(pose);
    configureWeightTransfer(walk, 1, 0); writeWalkingPose(skin, rig, walk, 0.6, pose);
    assert.deepEqual(pose, baseline);
    for (const [strength, limit] of [[NaN, 1], [-1, 1], [2, 1], [1, -1], [1, Infinity]]) assert.throws(() => configureWeightTransfer(walk, strength, limit));
  }
});

test('torso travel spreads across the cycle instead of rushing through the centre', () => {
  const { walk, skin, rig, pose } = fixture(2);
  configureWeightTransfer(walk, 1, 0.15);
  for (const period of [1.8, 3.6]) {
    configureGait(walk.gait, { ...defaultGaitSettings, period });
    const step = period / 240;
    let previousX = 0, previousZ = 0, peakSpeed = 0;
    for (let frame = 0; frame <= 240; frame++) {
      writeWalkingPose(skin, rig, walk, preparationSeconds + period + frame * step, pose);
      const [x, , z] = walk.transfer.offset;
      if (frame) peakSpeed = Math.max(peakSpeed, Math.hypot(x - previousX, z - previousZ) / step);
      previousX = x; previousZ = z;
    }
    assert.ok(peakSpeed < 8 * 0.15 / period, `Torso crossed too quickly: ${peakSpeed} m/s at a ${period} s period`);
  }
});

test('settling takes sequential steps toward the standing stance after a curved stop', () => {
  for (const count of [0, 1, 2, 4, 7]) {
    const { walk } = fixture(count, count === 7), gait = walk.gait;
    setGaitTurn(gait, 0, 0.15);
    setGaitMoving(gait, 2.1, false);
    if (!count) { sampleGait(gait, 30); assert.equal(gait.motion, 'standing'); assert.equal(gait.settlingRemaining, 0); continue; }
    const command = gait.commands.at(-1)!;
    const steps = command.settles.filter(step => step !== null).sort((a, b) => a.liftOff - b.liftOff);
    if (count) assert.ok(steps.length > 0);
    for (let i = 0; i < steps.length; i++) {
      assert.ok(steps[i].liftOff >= 2.7);
      if (i) assert.ok(steps[i].liftOff > steps[i - 1].touchdown);
      const time = (steps[i].liftOff + steps[i].touchdown) / 2;
      sampleGait(gait, time);
      assert.equal(gait.motion, 'settling'); assert.equal(gait.currentSpeed, 0);
      assert.equal(gait.planted.filter(value => value === 0).length, 1);
      const before = gait.legs.map(leg => groundFoot(gait, leg.foot)), planted = gait.planted.slice();
      sampleGait(gait, time + 0.01);
      for (const leg of gait.legs) if (planted[leg.foot]) groundFoot(gait, leg.foot).forEach((value, axis) => assert.ok(Math.abs(value - before[leg.foot][axis]) < 1e-9));
      const foot = command.settles.indexOf(steps[i]), epsilon = 1e-6;
      for (const boundary of [steps[i].liftOff, steps[i].touchdown]) {
        sampleGait(gait, boundary - epsilon); const before = groundFoot(gait, foot);
        sampleGait(gait, boundary); const at = groundFoot(gait, foot);
        sampleGait(gait, boundary + epsilon); const after = groundFoot(gait, foot);
        at.forEach((value, axis) => assert.ok(Math.abs((value - before[axis]) / epsilon - (after[axis] - value) / epsilon) < 0.001));
      }
    }
    sampleGait(gait, 30);
    assert.equal(gait.motion, 'standing'); assert.equal(gait.settlingRemaining, 0);
    for (const leg of gait.legs) assert.ok(Math.hypot(gait.offsets[leg.foot * 3], gait.offsets[leg.foot * 3 + 2]) <= 0.020001);
    const root = gait.rootTravel.slice(), yaw = gait.yaw;
    sampleGait(gait, 50); assert.deepEqual(gait.rootTravel, root); assert.equal(gait.yaw, yaw);
  }
});

test('stopping almost immediately skips unnecessary settling steps', () => {
  const { walk } = fixture(2), gait = walk.gait;
  setGaitMoving(gait, 0.01, false);
  assert.ok(gait.commands.at(-1)!.settles.every(step => step === null));
  sampleGait(gait, 5);
  assert.equal(gait.motion, 'standing'); assert.ok(gait.planted.every(Boolean));
  const expected = gait.offsets.slice(); sampleGait(gait, 20);
  assert.deepEqual(gait.offsets, expected);
});

test('planted foot headings stay fixed on the ground during turns', () => {
  const { walk, skin, rig, pose } = fixture(2), gait = walk.gait;
  setGaitTurn(gait, 0, 0.2);
  for (const leg of gait.legs) {
    const touchdown = preparationSeconds + (leg.trigger + 1 - gait.duty) * gait.groups[leg.group].period;
    let heading = 0;
    const rest = walk.footOrientations[leg.foot], axis = Math.hypot(rest[0], rest[2]) >= Math.hypot(rest[8], rest[10]) ? 0 : 8;
    for (let frame = 0; frame < 12; frame++) {
      writeWalkingPose(skin, rig, walk, touchdown + 0.05 + frame * 0.03, pose);
      assert.equal(gait.planted[leg.foot], 1);
      const matrix = pose.creature[walk.stance.contacts[leg.foot].bone];
      const actual = Math.atan2(-matrix[axis + 2], matrix[axis]) + gait.yaw;
      if (!frame) heading = actual;
      assert.ok(Math.abs(Math.atan2(Math.sin(actual - heading), Math.cos(actual - heading))) < 1e-5);
      assert.ok(walk.maximumError < 0.01);
    }
  }
});

test('reverse driving and direction changes preserve continuity, foot contact and replay', () => {
  const { walk, skin, rig, pose } = fixture(2), gait = walk.gait;
  setGaitDrive(gait, 0, -gait.speed, 0.1);
  sampleGait(gait, 1);
  assert.ok(gait.currentSpeed < 0); assert.ok(gait.yaw < 0);
  const root = gait.rootTravel.slice(), offsets = gait.offsets.slice(), yaw = gait.yaw;
  setGaitDrive(gait, 1, gait.speed, -0.1); sampleGait(gait, 1);
  assert.deepEqual(gait.rootTravel, root); assert.deepEqual(gait.offsets, offsets); assert.equal(gait.yaw, yaw);
  for (let frame = 0; frame < 90; frame++) {
    writeWalkingPose(skin, rig, walk, frame / 30, pose);
    assert.ok(walk.maximumError < 0.01, `reverse contact error ${walk.maximumError}`);
  }
  setGaitDrive(gait, 3, 0, 0);
  writeWalkingPose(skin, rig, walk, 12, pose); assert.equal(gait.motion, 'standing');
  const expected = structuredClone(pose);
  writeWalkingPose(skin, rig, walk, 1.5, pose); writeWalkingPose(skin, rig, walk, 12, pose);
  assert.deepEqual(pose, expected);
});

test('repeated starts retain alternating support through walking and settling interruptions', () => {
  const { walk, skin, rig, pose } = fixture(2), original = walk.gait;
  for (let stop = 0.3; stop < 4; stop += 0.2) for (const delay of [0.05, 0.2, 0.5, 1, 2]) {
    const gait = structuredClone(original);
    setGaitMoving(gait, stop, false);
    setGaitMoving(gait, stop + delay, true);
    for (let frame = 0; frame < 240; frame++) {
      const seconds = stop + delay + frame / 60;
      sampleGait(gait, seconds);
      assert.ok(gait.planted.some(Boolean), `Both feet flying at ${seconds}, stop ${stop}, restart delay ${delay}`);
    }
  }
  for (const stop of [0.3, 1.3, 2.3]) {
    setGaitMoving(original, stop, false);
    setGaitMoving(original, stop + 0.05, true);
  }
  for (let frame = 0; frame < 300; frame++) {
    writeWalkingPose(skin, rig, walk, frame / 60, pose);
    assert.ok(walk.planted > 0);
    assert.ok(walk.maximumError < 0.01, `Restart contact error ${walk.maximumError} at ${frame / 60}`);
  }
});

test('restarting during a settling flight preserves its path and cancels pending steps', () => {
  const { walk, skin, rig, pose } = fixture(4), gait = walk.gait;
  configureWeightTransfer(walk, 1, 0.15);
  setGaitMoving(gait, 2.1, false);
  const command = gait.commands.at(-1)!;
  const foot = command.settles.findIndex(step => step !== null), step = command.settles[foot]!;
  const seconds = (step.liftOff + step.touchdown) / 2;
  const previous = structuredClone(gait);
  sampleGait(gait, seconds); const before = groundFoot(gait, foot);
  setGaitMoving(gait, seconds, true); sampleGait(gait, seconds);
  groundFoot(gait, foot).forEach((value, axis) => assert.ok(Math.abs(value - before[axis]) < 1e-9));
  for (const time of [seconds + 0.01, step.touchdown - 0.001]) {
    sampleGait(gait, time); sampleGait(previous, time);
    const expected = groundFoot(previous, foot);
    groundFoot(gait, foot).forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-9));
  }
  writeWalkingPose(skin, rig, walk, seconds + 0.01, pose); const expected = structuredClone(pose);
  writeWalkingPose(skin, rig, walk, 30, pose); writeWalkingPose(skin, rig, walk, seconds + 0.01, pose);
  assert.deepEqual(pose, expected);
  setGaitMoving(gait, seconds + 0.1, false);
  for (let frame = 0; frame < 240; frame++) {
    writeWalkingPose(skin, rig, walk, 2.1 + frame / 30, pose);
    assert.ok(walk.maximumError < 0.01, `contact error ${walk.maximumError} at ${2.1 + frame / 30}`);
  }
});
