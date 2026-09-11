import { mat4 } from 'gl-matrix';
import { validateCreature } from '../creature/creature.ts';
import type { Creature } from '../creature/creature.ts';

export type Bone = {
  id: string;
  sourceId: string;
  kind: 'spine';
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
  for (const vertebra of creature.spine) {
    const parent = bones.length - 1;
    const restCreature = new Float32Array(16);
    mat4.fromRotationTranslation(restCreature, vertebra.orientation, vertebra.position);
    const inverseBind = new Float32Array(16);
    if (!mat4.invert(inverseBind, restCreature)) throw new Error('A bone rest transform must be invertible.');
    const restLocal = new Float32Array(16);
    if (parent < 0) restLocal.set(restCreature);
    else mat4.multiply(restLocal, bones[parent].inverseBind, restCreature);
    bones.push({ id: `spine:${vertebra.id}`, sourceId: vertebra.id, kind: 'spine', parent, restLocal, restCreature, inverseBind });
  }
  return bones;
}
