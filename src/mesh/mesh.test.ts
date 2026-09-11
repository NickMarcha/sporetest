import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createCreature } from '../creature/creature.ts';
import { createField } from '../field/field.ts';
import { meshField } from './mesh.ts';

test('sphere skin is closed, outward wound, and near the authored radius', () => {
  const creature = createCreature();
  creature.spine = [{ id: 'single', position: [0, 0, 0], radius: 1, orientation: [0, 0, 0, 1] }];
  const skin = meshField(createField(creature), 0.1);
  assert.ok(skin.positions.length > 0);
  assert.ok(skin.positions.every(Number.isFinite));
  assert.ok(skin.normals.every(Number.isFinite));
  const edges = new Map<string, number>();
  let volume = 0;
  for (let index = 0; index < skin.triangles.length; index += 3) {
    const [a, b, c] = skin.triangles.slice(index, index + 3);
    for (const [start, end] of [[a, b], [b, c], [c, a]]) {
      const key = `${Math.min(start, end)},${Math.max(start, end)}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    const p = skin.positions;
    volume += (p[a * 3] * (p[b * 3 + 1] * p[c * 3 + 2] - p[b * 3 + 2] * p[c * 3 + 1]) +
      p[a * 3 + 1] * (p[b * 3 + 2] * p[c * 3] - p[b * 3] * p[c * 3 + 2]) +
      p[a * 3 + 2] * (p[b * 3] * p[c * 3 + 1] - p[b * 3 + 1] * p[c * 3])) / 6;
  }
  assert.ok([...edges.values()].every(count => count === 2), 'Every sphere edge has exactly two faces.');
  assert.ok(Math.abs(volume - 4 * Math.PI / 3) < 0.12, `Outward signed volume: ${volume}`);
  for (let index = 0; index < skin.positions.length; index += 3) {
    assert.ok(Math.abs(Math.hypot(...skin.positions.slice(index, index + 3)) - 1) < 0.025);
    const length = Math.hypot(...skin.positions.slice(index, index + 3));
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(skin.normals[index + axis] - skin.positions[index + axis] / length) < 1e-6);
  }
});

test('every skin vertex retains nonnegative provenance with valid source references', () => {
  const skin = meshField(createField(createCreature()));
  const provenance = skin.provenance;
  assert.equal(provenance.offsets.length, skin.positions.length / 3 + 1);
  assert.equal(provenance.offsets.at(-1), provenance.values.length);
  assert.equal(provenance.values.length, provenance.sources.length);
  for (let vertex = 0; vertex < skin.positions.length / 3; vertex++) {
    const start = provenance.offsets[vertex];
    const end = provenance.offsets[vertex + 1];
    const total = provenance.values.subarray(start, end).reduce((sum, value) => sum + value, 0);
    assert.ok(total > 0);
    assert.ok(provenance.values.subarray(start, end).every(value => value > 0));
    assert.ok(provenance.sources.subarray(start, end).every(source => source < provenance.sourceIds.length));
    assert.ok(Math.abs(provenance.values.subarray(start, end).reduce((sum, value) => sum + value / total, 0) - 1) < 1e-6);
  }
});

test('small edits move skin even without requiring a topology change', () => {
  const creature = createCreature();
  const before = meshField(createField(creature));
  creature.spine[2].position[1] += 0.005;
  const after = meshField(createField(creature));
  assert.notDeepEqual(before.positions, after.positions);
  assert.ok(after.positions.every(Number.isFinite));
});

test('pure core imports no renderer or browser layer', () => {
  for (const folder of ['creature', 'field', 'mesh']) {
    const directory = new URL(`../${folder}/`, import.meta.url);
    for (const file of readdirSync(directory).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      const source = readFileSync(new URL(file, directory), 'utf8');
      assert.doesNotMatch(source, /(?:from\s*|import\s*)['"](?:three|.*\/(?:render|editor)\/)/);
    }
  }
});

test('bent, stretched, and coincident spines produce finite skins', () => {
  for (const positions of [
    [[-2, 0, 0], [0, 1.6, 0], [2, 0, 0]],
    [[-4, 0, 0], [0, 0, 0], [4, 0, 0]],
    [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
  ]) {
    const creature = createCreature();
    creature.spine = creature.spine.slice(0, 3);
    creature.spine.forEach((vertebra, index) => { vertebra.position = [positions[index][0], positions[index][1], positions[index][2]]; vertebra.radius = 0.5; });
    const skin = meshField(createField(creature));
    assert.ok(skin.positions.length > 0);
    assert.ok(skin.positions.every(Number.isFinite));
    assert.ok(skin.normals.every(Number.isFinite));
    assert.ok(skin.triangles.every(index => index < skin.positions.length / 3));
  }
});
