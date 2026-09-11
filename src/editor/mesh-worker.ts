import { createField } from '../field/field.ts';
import { meshField } from '../mesh/mesh.ts';
import type { Creature } from '../creature/creature.ts';
import type { Skin } from '../mesh/mesh.ts';

export type MeshRequest = { revision: number; creature: Creature; resolution: number };
export type MeshResponse =
  | { revision: number; skin: Skin; milliseconds: number }
  | { revision: number; error: string };

self.onmessage = (event: MessageEvent<MeshRequest>) => {
  const { revision, creature, resolution } = event.data;
  try {
    const start = performance.now();
    const field = createField(creature);
    const skin = meshField(field, field.minimumRadius / resolution);
    const response: MeshResponse = { revision, skin, milliseconds: performance.now() - start };
    self.postMessage(response, {
      transfer: [skin.positions.buffer, skin.normals.buffer, skin.triangles.buffer, skin.provenance.offsets.buffer,
        skin.provenance.sources.buffer, skin.provenance.values.buffer],
    });
  } catch (error) {
    const response: MeshResponse = { revision, error: error instanceof Error ? error.message : 'Meshing failed.' };
    self.postMessage(response);
  }
};
