import { quat } from 'gl-matrix';

/** Metres in the fixed creature authoring frame, right handed, +Y up. */
export type Position = [number, number, number];
/** Unit quaternion, [x, y, z, w], in creature space. */
export type Orientation = [number, number, number, number];
export type Vertebra = {
  id: string;
  position: Position;
  radius: number;
  orientation: Orientation;
};

/** The first slice authors a spine and a skin colour. Parts arrive with their editor. */
export type Creature = { spine: Vertebra[]; skinColor: string };
export type Mutation =
  | { type: 'move'; id: string; position: Position }
  | { type: 'radius'; id: string; radius: number }
  | { type: 'insert'; after: string; vertebra: Vertebra }
  | { type: 'remove'; id: string }
  | { type: 'color'; color: string };
export type Recipe = { base: Creature; mutations: Mutation[] };

export function validateCreature(creature: Creature) {
  if (creature.spine.length === 0) throw new Error('A spine needs at least one vertebra.');
  const ids = new Set<string>();
  for (const vertebra of creature.spine) {
    if (!vertebra.id || ids.has(vertebra.id)) throw new Error('Vertebra identifiers must be unique.');
    ids.add(vertebra.id);
    if (vertebra.position.length !== 3 || !vertebra.position.every(Number.isFinite)) {
      throw new Error('Vertebra positions must contain three finite numbers.');
    }
    if (!Number.isFinite(vertebra.radius) || vertebra.radius <= 0) throw new Error('Radius must be positive.');
    if (vertebra.orientation.length !== 4 || !vertebra.orientation.every(Number.isFinite) ||
      Math.abs(quat.length(vertebra.orientation) - 1) > 1e-5) throw new Error('Orientation must be a unit quaternion.');
  }
  if (!/^#[\da-f]{6}$/i.test(creature.skinColor)) throw new Error('Skin colour must be a six-digit hex colour.');
}

export function applyMutation(creature: Creature, mutation: Mutation): Creature {
  const next = structuredClone(creature);
  if (mutation.type === 'color') next.skinColor = mutation.color;
  else {
    const id = mutation.type === 'insert' ? mutation.after : mutation.id;
    const index = next.spine.findIndex(vertebra => vertebra.id === id);
    if (index < 0) throw new Error(`No vertebra with identifier ${id}.`);
    switch (mutation.type) {
      case 'move': next.spine[index].position = [...mutation.position]; break;
      case 'radius': next.spine[index].radius = mutation.radius; break;
      case 'insert': next.spine.splice(index + 1, 0, structuredClone(mutation.vertebra)); break;
      case 'remove': next.spine.splice(index, 1); break;
    }
  }
  validateCreature(next);
  return next;
}

export function replayRecipe(recipe: Recipe): Creature {
  validateCreature(recipe.base);
  return recipe.mutations.reduce(applyMutation, structuredClone(recipe.base));
}

export function createCreature(): Creature {
  return {
    skinColor: '#91ae9e',
    spine: [
      { id: 'v1', position: [-1.65, 0.25, 0], radius: 0.43, orientation: [0, 0, 0, 1] },
      { id: 'v2', position: [-0.9, 0.12, 0], radius: 0.67, orientation: [0, 0, 0, 1] },
      { id: 'v3', position: [0, 0, 0], radius: 0.76, orientation: [0, 0, 0, 1] },
      { id: 'v4', position: [0.85, 0.12, 0], radius: 0.54, orientation: [0, 0, 0, 1] },
      { id: 'v5', position: [1.55, 0.3, 0], radius: 0.27, orientation: [0, 0, 0, 1] },
    ],
  };
}
