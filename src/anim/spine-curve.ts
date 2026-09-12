import { mat4, quat, vec3 } from 'gl-matrix';
import type { Bone } from '../rig/skeleton.ts';

/** Quintic Hermite basis: position, first derivative and second derivative at each end. */
function basis(t: number) {
  const t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
  return [1 - 10 * t3 + 15 * t4 - 6 * t5, 10 * t3 - 15 * t4 + 6 * t5,
    t - 6 * t3 + 8 * t4 - 3 * t5, -4 * t3 + 7 * t4 - 3 * t5,
    (t2 - 3 * t3 + 3 * t4 - t5) / 2, (t3 - 2 * t4 + t5) / 2];
}

/** Evaluate position and tangent into caller-owned buffers, with no allocations. */
export function sampleSpineCurve(data: Float64Array, t: number, position: vec3, tangent: vec3) {
  const t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
  const h0 = 1 - 10 * t3 + 15 * t4 - 6 * t5, h1 = 1 - h0;
  const h2 = t - 6 * t3 + 8 * t4 - 3 * t5, h3 = -4 * t3 + 7 * t4 - 3 * t5;
  const h4 = (t2 - 3 * t3 + 3 * t4 - t5) / 2, h5 = (t3 - 2 * t4 + t5) / 2;
  const d0 = -30 * t2 + 60 * t3 - 30 * t4, d1 = -d0;
  const d2 = 1 - 18 * t2 + 32 * t3 - 15 * t4, d3 = -12 * t2 + 28 * t3 - 15 * t4;
  const d4 = (2 * t - 9 * t2 + 12 * t3 - 5 * t4) / 2, d5 = (3 * t2 - 8 * t3 + 5 * t4) / 2;
  for (let axis = 0; axis < 3; axis++) {
    position[axis] = h0 * data[axis] + h1 * data[3 + axis] + h2 * data[6 + axis] + h3 * data[9 + axis] + h4 * data[12 + axis] + h5 * data[15 + axis];
    tangent[axis] = d0 * data[axis] + d1 * data[3 + axis] + d2 * data[6 + axis] + d3 * data[9 + axis] + d4 * data[12 + axis] + d5 * data[15 + axis];
  }
}

/** Per-edit least-squares fit, with endpoints fixed and a small straight-chord prior for rank-deficient spans. */
export function fitSpineCurve(bones: Bone[], indices: number[]) {
  const parameters = new Float64Array(indices.length);
  for (let i = 1; i < indices.length; i++) {
    const a = bones[indices[i - 1]].restCreature, b = bones[indices[i]].restCreature;
    parameters[i] = parameters[i - 1] + Math.hypot(b[12] - a[12], b[13] - a[13], b[14] - a[14]);
  }
  const arcLength = parameters[parameters.length - 1];
  parameters.forEach((value, i) => { parameters[i] = arcLength > 1e-8 ? value / arcLength : i / (indices.length - 1); });
  const data = new Float64Array(18);
  const first = bones[indices[0]].restCreature, last = bones[indices[indices.length - 1]].restCreature;
  for (let axis = 0; axis < 3; axis++) {
    data[axis] = first[12 + axis]; data[3 + axis] = last[12 + axis];
    data[6 + axis] = data[9 + axis] = last[12 + axis] - first[12 + axis];
  }
  // Solve four endpoint derivative corrections per coordinate. Regularisation makes
  // short/coincident spans well-defined without replacing the quintic with another curve.
  const system = Array.from({ length: 4 }, (_, i) => Array.from({ length: 7 }, (_, j) => i === j ? 1e-5 : 0));
  for (let i = 1; i < indices.length - 1; i++) {
    const t = parameters[i], h = basis(t), matrix = bones[indices[i]].restCreature;
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) system[row][col] += h[row + 2] * h[col + 2];
      for (let axis = 0; axis < 3; axis++) {
        const linear = first[12 + axis] * (1 - t) + last[12 + axis] * t;
        system[row][4 + axis] += h[row + 2] * (matrix[12 + axis] - linear);
      }
    }
  }
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let row = col + 1; row < 4; row++) if (Math.abs(system[row][col]) > Math.abs(system[pivot][col])) pivot = row;
    [system[col], system[pivot]] = [system[pivot], system[col]];
    const divisor = system[col][col];
    for (let j = col; j < 7; j++) system[col][j] /= divisor;
    for (let row = 0; row < 4; row++) if (row !== col) {
      const factor = system[row][col];
      for (let j = col; j < 7; j++) system[row][j] -= factor * system[col][j];
    }
  }
  for (let derivative = 0; derivative < 4; derivative++) for (let axis = 0; axis < 3; axis++) data[6 + derivative * 3 + axis] += system[derivative][4 + axis];
  const frames: Float32Array[] = [], offsets: Float32Array[] = [], orientations: Float32Array[] = [];
  const position = vec3.create(), tangent = vec3.create(), previous = vec3.fromValues(0, 1, 0);
  const frame = quat.create(), rotation = quat.create(), inverse = quat.create(), orientation = quat.create();
  for (let i = 0; i < indices.length; i++) {
    sampleSpineCurve(data, parameters[i], position, tangent);
    if (vec3.squaredLength(tangent) < 1e-12) vec3.copy(tangent, previous);
    vec3.normalize(tangent, tangent); quat.rotationTo(rotation, previous, tangent); quat.multiply(frame, rotation, frame);
    quat.normalize(frame, frame); vec3.copy(previous, tangent);
    frames.push(new Float32Array(frame)); quat.conjugate(inverse, frame);
    const matrix = bones[indices[i]].restCreature;
    const offset = vec3.fromValues(matrix[12] - position[0], matrix[13] - position[1], matrix[14] - position[2]);
    vec3.transformQuat(offset, offset, inverse); offsets.push(new Float32Array(offset));
    mat4.getRotation(orientation, matrix); quat.multiply(orientation, inverse, orientation);
    orientations.push(new Float32Array(orientation));
  }
  return { indices: Int32Array.from(indices), parameters, data, arcLength, frames, offsets, orientations,
    posed: new Float64Array(18) };
}
