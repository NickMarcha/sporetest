import { createField } from '../field/field.ts';
import { meshField } from '../mesh/mesh.ts';
import type { Creature } from '../creature/creature.ts';
import type { Skin } from '../mesh/mesh.ts';
import { createRig } from '../rig/rig.ts';
import type { Rig } from '../rig/rig.ts';

export type MeshRequest = { revision: number; creature: Creature; resolution: number; smoothing: number; skin?: Skin };
export type MeshResponse =
  | { revision: number; skin: Skin; rig: Rig; milliseconds: number; bindMilliseconds: number; meshed: boolean }
  | { revision: number; error: string };

self.onmessage = (event: MessageEvent<MeshRequest>) => {
  const { revision, creature, resolution, smoothing } = event.data;
  try {
    const start = performance.now();
    const skin = event.data.skin ?? (() => {
      const field = createField(creature);
      return meshField(field, field.minimumRadius / resolution);
    })();
    const milliseconds = performance.now() - start;
    const bindStart = performance.now();
    const rig = createRig(creature, skin, smoothing);
    const response: MeshResponse = { revision, skin, rig, milliseconds, bindMilliseconds: performance.now() - bindStart, meshed: !event.data.skin };
    self.postMessage(response, {
      transfer: [skin.positions.buffer, skin.normals.buffer, skin.triangles.buffer, skin.provenance.offsets.buffer,
        skin.provenance.sources.buffer, skin.provenance.values.buffer,
        rig.weights.offsets.buffer, rig.weights.bones.buffer, rig.weights.values.buffer],
    });
  } catch (error) {
    const response: MeshResponse = { revision, error: error instanceof Error ? error.message : 'Meshing failed.' };
    self.postMessage(response);
  }
};
