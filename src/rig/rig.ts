import type { Creature } from '../creature/creature.ts';
import type { Skin } from '../mesh/mesh.ts';
import { deriveBones } from './skeleton.ts';
import { bindWeights } from './weights.ts';

export function createRig(creature: Creature, skin: Skin, smoothingPasses = 4) {
  const bones = deriveBones(creature);
  return { bones, weights: bindWeights(skin, bones, smoothingPasses) };
}
export type Rig = ReturnType<typeof createRig>;
