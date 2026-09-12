import { mat4, quat } from 'gl-matrix';
import type { Creature, Limb, Position, Orientation, Cap } from './creature.ts';

/** Resolved authored source in creature space. Parent IDs become indices only in the rig. */
export type Source = { id: string; parentId: string | null; kind: 'spine' | 'limb'; position: Position; orientation: Orientation; radius: number; cap: Cap | null };

export function resolveStructure(creature: Creature) {
  const sources: Source[] = creature.spine.map((vertebra, index) => ({ ...vertebra, parentId: creature.spine[index - 1]?.id ?? null, kind: 'spine', cap: null }));
  const chains: Source[][] = [sources.slice()];
  const byId = new Map(sources.map(source => [source.id, source]));
  function visit(parts: Limb[]) {
    for (const part of parts) {
      const parent = byId.get(part.socket.sourceId);
      if (!parent) throw new Error('Socket source is missing.');
      const parentFrame = mat4.fromRotationTranslation(mat4.create(), parent.orientation, parent.position);
      const socketFrame = mat4.fromRotationTranslation(mat4.create(), part.socket.orientation, part.socket.position);
      mat4.multiply(socketFrame, parentFrame, socketFrame);
      // The buried connector meets the parent centre, with limb thickness rather than torso thickness.
      const chain: Source[] = [{ ...parent, radius: part.segments[0].radius }];
      part.segments.forEach((segment, index) => {
        const frame = mat4.fromRotationTranslation(mat4.create(), segment.orientation, segment.position);
        mat4.multiply(frame, socketFrame, frame);
        const orientation: Orientation = [0, 0, 0, 1];
        mat4.getRotation(orientation, frame); quat.normalize(orientation, orientation);
        const source: Source = { id: segment.id, parentId: index === 0 ? parent.id : part.segments[index - 1].id, kind: 'limb',
          position: [frame[12], frame[13], frame[14]], orientation, radius: segment.radius,
          cap: index === part.segments.length - 1 ? part.cap : null };
        sources.push(source); byId.set(source.id, source); chain.push(source);
      });
      chains.push(chain);
      visit(part.parts);
    }
  }
  visit(creature.parts);
  return { sources, chains };
}
