import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, createCreature, replayRecipe } from './creature.ts';
import { attachmentPositions, createAttachedLimb, moveLimbSegment } from './attachment.ts';
import { resolveStructure } from './structure.ts';
import type { AttachmentPoint } from './attachment.ts';
import type { Recipe } from './creature.ts';

function identifiers() { let index = 0; return () => `placed-${index++}`; }
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);

test('picked skin positions survive conversion through a rotated parent frame', () => {
  const creature = createCreature(); creature.spine = [creature.spine[2]];
  creature.spine[0].position = [2, 3, 4];
  creature.spine[0].orientation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  const hit: AttachmentPoint = { position: [2.3, 3.2, 4.6], normal: [0, 0, 1] };
  const limb = createAttachedLimb(creature, hit, 'leg', identifiers());
  const attached = applyMutation(creature, { type: 'attach', limb });
  const sources = resolveStructure(attached).sources.filter(source => source.kind === 'limb');
  attachmentPositions(hit, 'leg').forEach((position, index) => position.forEach((value, axis) => close(value, sources[index].position[axis])));
  assert.equal(limb.cap, 'foot');
  assert.deepEqual(creature.parts, []);
});

test('separate attachments can produce reflected limbs without creating a mirror link', () => {
  const base = createCreature(), id = identifiers();
  const near = createAttachedLimb(base, { position: [0, 0, 0.76], normal: [0, 0, 1] }, 'leg', id);
  const far = createAttachedLimb(base, { position: [0, 0, -0.76], normal: [0, 0, -1] }, 'leg', id);
  const recipe: Recipe = { base, mutations: [ { type: 'attach', limb: near }, { type: 'attach', limb: far } ] };
  const creature = replayRecipe(JSON.parse(JSON.stringify(recipe)) as Recipe);
  const sources = resolveStructure(creature).sources.filter(source => source.kind === 'limb');
  for (let index = 0; index < 3; index++) {
    close(sources[index].position[0], sources[index + 3].position[0]);
    close(sources[index].position[1], sources[index + 3].position[1]);
    close(sources[index].position[2], -sources[index + 3].position[2]);
  }
  const changed = applyMutation(creature, moveLimbSegment(creature, near.segments[2].id, [1, 2, 3]));
  assert.deepEqual(changed.parts[1], creature.parts[1]);
});

test('central placement stays on the centre plane and arms carry grasper caps', () => {
  const creature = createCreature();
  const limb = createAttachedLimb(creature, { position: [0, -0.76, 0], normal: [0, -1, 0] }, 'arm', identifiers());
  const sources = resolveStructure(applyMutation(creature, { type: 'attach', limb })).sources;
  assert.equal(limb.cap, 'grasper');
  for (const source of sources.filter(source => source.kind === 'limb')) close(source.position[2], 0);
});

test('viewport dragging converts nested segments back to socket space', () => {
  let creature = createCreature(); const id = identifiers();
  const parent = createAttachedLimb(creature, { position: [0, 0, 0.76], normal: [0, 0, 1] }, 'arm', id);
  parent.socket.orientation = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  creature = applyMutation(creature, { type: 'attach', limb: parent });
  const point = resolveStructure(creature).sources.at(-1)!.position;
  const child = createAttachedLimb(creature, { position: [...point], normal: [1, 0, 0] }, 'arm', id);
  creature = applyMutation(creature, { type: 'attach', limb: child });
  const moved = applyMutation(creature, moveLimbSegment(creature, child.segments[1].id, [2, -3, 1]));
  const source = resolveStructure(moved).sources.find(source => source.id === child.segments[1].id)!;
  [2, -3, 1].forEach((value, axis) => close(source.position[axis], value));
  assert.throws(() => moveLimbSegment(creature, 'missing', [0, 0, 0]), /missing/);
});
