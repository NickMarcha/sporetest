import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCreature } from '../creature/creature.ts';
import type { Creature, Position } from '../creature/creature.ts';
import { createField, evaluateField, evaluateNormal, evaluateProvenance, ISOVALUE } from './field.ts';

function chain(positions: Position[], radius = 0.5): Creature {
  return { parts: [], mirrorPairs: [], skinColor: '#aabbcc', spine: positions.map((position, index) => ({ id: `v${index}`, position, radius, orientation: [0, 0, 0, 1] })) };
}

test('one vertebra has the authored radius and compact support', () => {
  const field = createField(chain([[0, 0, 0]]));
  assert.ok(evaluateField(field, 0, 0, 0) > 0);
  assert.ok(Math.abs(evaluateField(field, 0.5, 0, 0)) < 1e-12);
  assert.equal(evaluateField(field, 10, 0, 0), -ISOVALUE);
  assert.equal(evaluateProvenance(field, 10, 0, 0)[0], 0);
});

test('a stretched spine stays connected and is insensitive to straight-segment subdivision', () => {
  const field = createField(chain([[-4, 0, 0], [4, 0, 0]]));
  const subdivided = createField(chain([[-4, 0, 0], [-0.3, 0, 0], [4, 0, 0]]));
  for (let x = -4; x <= 4; x += 0.1) {
    assert.ok(evaluateField(field, x, 0, 0) > 0);
    assert.ok(Math.abs(evaluateField(field, x, 0.3, 0) - evaluateField(subdivided, x, 0.3, 0)) < 0.003);
  }
});

test('provenance sums to field density and follows authored identities', () => {
  const field = createField(createCreature());
  for (const point of [[0, 0, 0], [0.3, 0.3, 0.2], [-1.6, 0.2, 0]] as Position[]) {
    const values = evaluateProvenance(field, ...point);
    assert.ok(values.every(value => value >= 0));
    assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0) - evaluateField(field, ...point) - ISOVALUE) < 1e-12);
  }
  assert.deepEqual(field.sourceIds, ['v1', 'v2', 'v3', 'v4', 'v5']);
});

test('coincident vertebrae and translated spines yield finite, consistent fields', () => {
  const field = createField(chain([[0, 0, 0], [0, 0, 0], [0, 0, 0]]));
  assert.ok(Number.isFinite(evaluateField(field, 0, 0, 0)));
  assert.ok(evaluateField(field, 0, 0, 0) > 0);
  const moved = createField(chain([[12, -5, 3], [13, -4, 4]]));
  const original = createField(chain([[0, 0, 0], [1, 1, 1]]));
  assert.ok(Math.abs(evaluateField(moved, 12.2, -4.8, 3.2) - evaluateField(original, 0.2, 0.2, 0.2)) < 1e-12);
});

test('analytic normals point down the field gradient', () => {
  const field = createField(createCreature());
  const point: Position = [0.3, 0.55, 0.2];
  const normal = evaluateNormal(field, ...point);
  const epsilon = 1e-5;
  const gradient = point.map((_, axis) => {
    const a: Position = [...point];
    const b: Position = [...point];
    a[axis] += epsilon;
    b[axis] -= epsilon;
    return (evaluateField(field, ...a) - evaluateField(field, ...b)) / (2 * epsilon);
  });
  const length = Math.hypot(...gradient);
  normal.forEach((value, axis) => assert.ok(Math.abs(value + gradient[axis] / length) < 1e-7));
  assert.deepEqual(evaluateNormal(field, 1e3, 1e3, 1e3), [0, 0, 0]);
});

test('coincident controls retain the largest radius and original source identity', () => {
  const creature = chain([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  creature.spine[1].radius = 1;
  const field = createField(creature);
  assert.ok(Math.abs(evaluateField(field, 1, 0, 0)) < 1e-12);
  assert.deepEqual(field.sourceIds, ['v0', 'v1', 'v2']);
  const provenance = evaluateProvenance(field, 0.5, 0, 0);
  assert.equal(provenance[0], 0);
  assert.ok(provenance[1] > 0);
  assert.equal(provenance[2], 0);
});
