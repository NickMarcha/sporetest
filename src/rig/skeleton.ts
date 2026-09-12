import { mat4 } from 'gl-matrix';
import { validateCreature } from '../creature/creature.ts';
import type { Creature } from '../creature/creature.ts';
import type { Cap } from '../creature/creature.ts';
import { resolveStructure } from '../creature/structure.ts';

export type Bone = {
  id: string;
  sourceId: string;
  kind: 'spine' | 'limb';
  cap: Cap | null;
  /** Parent precedes child; -1 denotes the root. */
  parent: number;
  /** Column-major matrices, translations in metres. */
  restLocal: Float32Array;
  restCreature: Float32Array;
  inverseBind: Float32Array;
};

export function deriveBones(creature: Creature): Bone[] {
  validateCreature(creature);
  const bones: Bone[] = [];
  const indices = new Map<string, number>();
  for (const vertebra of resolveStructure(creature).sources) {
    const parent = vertebra.parentId === null ? -1 : indices.get(vertebra.parentId)!;
    const restCreature = new Float32Array(16);
    mat4.fromRotationTranslation(restCreature, vertebra.orientation, vertebra.position);
    const inverseBind = new Float32Array(16);
    if (!mat4.invert(inverseBind, restCreature)) throw new Error('A bone rest transform must be invertible.');
    const restLocal = new Float32Array(16);
    if (parent < 0) restLocal.set(restCreature);
    else mat4.multiply(restLocal, bones[parent].inverseBind, restCreature);
    indices.set(vertebra.id, bones.length);
    bones.push({ id: `${vertebra.kind}:${vertebra.id}`, sourceId: vertebra.id, kind: vertebra.kind, cap: vertebra.cap, parent, restLocal, restCreature, inverseBind });
  }
  return bones;
}
