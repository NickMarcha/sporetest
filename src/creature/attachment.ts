import { mat4, quat, vec3 } from 'gl-matrix';
import { allLimbs } from './creature.ts';
import type { Creature, Limb, Mutation, Position, Orientation } from './creature.ts';
import { resolveStructure } from './structure.ts';

export type AttachmentPoint = { position: Position; normal: Position };

export function attachmentPositions(hit: AttachmentPoint, kind: 'arm' | 'leg'): Position[] {
  const outward: Position = [...hit.normal];
  vec3.normalize(outward, outward);
  const elbow: Position = kind === 'leg' ? [0, -0.35, 0] : [-0.15, -0.15, 0];
  const tip: Position = kind === 'leg' ? [0.2, -1.2, 0] : [-0.35, -0.45, 0];
  vec3.scaleAndAdd(elbow, elbow, outward, 0.65);
  vec3.scaleAndAdd(tip, tip, outward, kind === 'leg' ? 0.85 : 1.05);
  vec3.add(elbow, elbow, hit.position); vec3.add(tip, tip, hit.position);
  return [[...hit.position], elbow, tip];
}

/** Convert a picked skin point in creature space into an authored socket and limb. */
export function createAttachedLimb(creature: Creature, hit: AttachmentPoint, kind: 'arm' | 'leg', identifier: () => string): Limb {
  const sources = resolveStructure(creature).sources;
  const parent = sources.reduce((best, source) =>
    vec3.distance(source.position, hit.position) / source.radius < vec3.distance(best.position, hit.position) / best.radius ? source : best);
  const inverse = mat4.fromRotationTranslation(mat4.create(), parent.orientation, parent.position);
  mat4.invert(inverse, inverse);
  const position: Position = [0, 0, 0];
  vec3.transformMat4(position, hit.position, inverse);
  const orientation: Orientation = [0, 0, 0, 1];
  quat.conjugate(orientation, parent.orientation);
  for (let index = 0; index < 4; index++) if (orientation[index] === 0) orientation[index] = 0;
  const positions = attachmentPositions(hit, kind);
  for (const position of positions) vec3.subtract(position, position, hit.position);
  return { id: identifier(), kind: 'limb', socket: { sourceId: parent.id, position, orientation }, cap: kind === 'leg' ? 'foot' : 'grasper', parts: [],
    segments: positions.map((position, index) => ({ id: identifier(), position, radius: [0.25, 0.19, 0.13][index], orientation: [0, 0, 0, 1] })) };
}

/** Drag positions arrive in creature space; authored segments remain in socket space. */
export function moveLimbSegment(creature: Creature, id: string, position: Position): Mutation {
  const original = allLimbs(creature.parts).find(limb => limb.segments.some(segment => segment.id === id));
  if (!original) throw new Error('Limb segment is missing.');
  const parent = resolveStructure(creature).sources.find(source => source.id === original.socket.sourceId)!;
  const frame = mat4.fromRotationTranslation(mat4.create(), parent.orientation, parent.position);
  const socket = mat4.fromRotationTranslation(mat4.create(), original.socket.orientation, original.socket.position);
  mat4.multiply(frame, frame, socket); mat4.invert(frame, frame);
  const limb = structuredClone(original);
  vec3.transformMat4(limb.segments.find(segment => segment.id === id)!.position, position, frame);
  return { type: 'replace-limb', limb };
}
