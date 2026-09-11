import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mat4, quat } from 'gl-matrix';
import { createCreature } from '../creature/creature.ts';
import { createField } from '../field/field.ts';
import { meshField } from '../mesh/mesh.ts';
import { deriveBones } from './skeleton.ts';
import { createRig } from './rig.ts';
import { bindWeights, meshAdjacency, packWeights } from './weights.ts';
import type { Skin } from '../mesh/mesh.ts';

test('bones preserve authored rest transforms, source identity, and parent order', () => {
  const creature = createCreature();
  quat.setAxisAngle(creature.spine[2].orientation, [0, 1, 0], 0.65);
  const bones = deriveBones(creature);
  assert.equal(bones.length, creature.spine.length);
  for (let index = 0; index < bones.length; index++) {
    const bone = bones[index];
    assert.equal(bone.sourceId, creature.spine[index].id);
    assert.equal(bone.parent, index - 1);
    const composed = new Float32Array(16);
    if (bone.parent >= 0) mat4.multiply(composed, bones[bone.parent].restCreature, bone.restLocal);
    else composed.set(bone.restLocal);
    composed.forEach((value, slot) => assert.ok(Math.abs(value - bone.restCreature[slot]) < 1e-6));
    const identity = mat4.multiply(new Float32Array(16), bone.restCreature, bone.inverseBind);
    for (let slot = 0; slot < 16; slot++) assert.ok(Math.abs(identity[slot] - (slot % 5 === 0 ? 1 : 0)) < 1e-6);
  }
  bones[0].restCreature[12] = 99;
  assert.notEqual(creature.spine[0].position[0], 99);
});

function twoTriangles(): Skin {
  return {
    positions: new Float32Array([0,0,0, 1,0,0, 0,1,0, 10,0,0, 11,0,0, 10,1,0]),
    normals: new Float32Array(18), triangles: new Uint32Array([0,1,2, 3,4,5]), cellSize: 1, sampledCells: 6,
    provenance: { sourceIds: ['v1','v2'], offsets: new Uint32Array([0,1,2,3,4,5,6]), sources: new Uint32Array([0,1,0,1,1,1]), values: new Float32Array([1,1,1,1,1,1]) },
  };
}

test('smoothing reduces a discontinuity without crossing disconnected skin', () => {
  const skin = twoTriangles();
  const bones = deriveBones(createCreature());
  const raw = bindWeights(skin, bones, 0);
  const smoothed = bindWeights(skin, bones, 4);
  const lookup = (weights: typeof raw, vertex: number, bone: number) => {
    for (let index = weights.offsets[vertex]; index < weights.offsets[vertex + 1]; index++) if (weights.bones[index] === bone) return weights.values[index];
    return 0;
  };
  assert.ok(Math.abs(lookup(smoothed, 0, 0) - lookup(smoothed, 1, 0)) < Math.abs(lookup(raw, 0, 0) - lookup(raw, 1, 0)));
  for (const vertex of [3,4,5]) { assert.equal(lookup(smoothed, vertex, 0), 0); assert.equal(lookup(smoothed, vertex, 1), 1); }
  assert.deepEqual(meshAdjacency(3, new Uint32Array([0,1,2, 0,1,2])), [[1,2],[0,2],[0,1]]);
});

test('binding normalises every vertex and resolves provenance by ID, not source order', () => {
  const creature = createCreature();
  const skin = meshField(createField(creature));
  skin.provenance.sourceIds.reverse();
  skin.provenance.sources = skin.provenance.sources.map(source => creature.spine.length - 1 - source);
  const rig = createRig(creature, skin);
  for (let vertex = 0; vertex < skin.positions.length / 3; vertex++) {
    let sum = 0;
    for (let index = rig.weights.offsets[vertex]; index < rig.weights.offsets[vertex + 1]; index++) {
      const value = rig.weights.values[index];
      assert.ok(value >= 0 && Number.isFinite(value));
      assert.ok(rig.weights.bones[index] < rig.bones.length);
      sum += value;
    }
    assert.ok(Math.abs(sum - 1) < 1e-6);
  }
  const reference = createRig(creature, meshField(createField(creature)));
  assert.deepEqual(rig.weights, reference.weights);
});

test('influence packing retains the strongest weights, normalises, and reports discarded mass', () => {
  const packed = packWeights({ offsets: new Uint32Array([0,5]), bones: new Uint32Array([0,1,2,3,4]), values: new Float32Array([0.05,0.3,0.2,0.35,0.1]) }, 4);
  assert.deepEqual([...packed.indices], [3,1,2,4]);
  assert.ok(Math.abs(packed.values.reduce((sum, value) => sum + value, 0) - 1) < 1e-6);
  assert.ok(Math.abs(packed.maximumDiscarded - 0.05) < 1e-6);
});

test('invalid provenance is rejected instead of silently attaching to a different bone', () => {
  const skin = twoTriangles();
  skin.provenance.sourceIds[0] = 'missing';
  assert.throws(() => bindWeights(skin, deriveBones(createCreature())), /no bone/);
  const zero = twoTriangles(); zero.provenance.values[0] = 0;
  assert.throws(() => bindWeights(zero, deriveBones(createCreature())), /positive source density/);
});
