import { allLimbs } from '../creature/creature.ts';
import type { Creature, Mutation, Limb, Cap, Position } from '../creature/creature.ts';


export function mountLimbEditor(host: HTMLElement, getCreature: () => Creature, mutate: (mutation: Mutation) => void, beginGesture: () => void, endGesture: () => void, selectInViewport: (id: string) => void) {
  host.innerHTML = `
    <div class="section-heading"><h2>Limbs</h2><span id="limb-count">0 limbs</span></div>
    <fieldset class="limb-fields">
      <p class="rig-explanation">Choose Arm or Leg above the creature, then click its skin. Drag the points to reshape a limb.</p>
      <div id="limb-details" hidden>
        <p id="mirror-link-status" class="rig-explanation"></p>
        <button class="button" id="limb-unlink" type="button">Unlink pair</button>
        <label class="limb-label">Selected limb<select id="limb-select"></select></label>
        <label class="limb-label">Segment<select id="limb-segment"></select></label>
        <div class="axis-label">Segment position <span>socket metres</span></div>
        <div class="coordinates">${['X', 'Y', 'Z'].map((axis, index) => `<label><span>${axis}</span><input type="number" step="0.1" data-segment-axis="${index}" aria-label="Limb position ${axis}"/></label>`).join('')}</div>
        <label class="limb-label">Segment radius<input id="limb-radius" type="number" min="0.05" step="0.05" aria-label="Limb radius"/></label>
        <div class="axis-label">Socket offset <span>parent metres</span></div>
        <div class="coordinates">${['X', 'Y', 'Z'].map((axis, index) => `<label><span>${axis}</span><input type="number" step="0.1" data-socket-axis="${index}" aria-label="Socket offset ${axis}"/></label>`).join('')}</div>
        <div class="button-row"><button class="button" id="segment-add" type="button">+ Segment</button><button class="button quiet" id="segment-remove" type="button">Remove segment</button></div>
        <label class="limb-label">Tip cap<select id="limb-cap"><option value="">None</option><option value="foot">Foot</option><option value="grasper">Grasper</option><option value="mouth">Mouth</option><option value="eye">Eye</option></select></label>
        <p class="rig-explanation">Caps mark a purpose for animation. Separate feet and other attached meshes come later.</p>
        <button class="button quiet" id="limb-remove" type="button">Remove limb & branches</button>
      </div>
    </fieldset>`;
  function find<T extends HTMLElement>(id: string) { return host.querySelector<T>(id)!; }

  const select = find<HTMLSelectElement>('#limb-select');
  const segmentSelect = find<HTMLSelectElement>('#limb-segment');
  let selected = '';
  let segmentIndex = 0;
  const listeners = new AbortController();
  function limb() { return allLimbs(getCreature().parts).find(part => part.id === selected); }
  function metres(value: number) { return String(Number(value.toFixed(4))); }
  function options(select: HTMLSelectElement, entries: Array<[string, string]>, value: string) {
    select.replaceChildren(...entries.map(([id, label]) => new Option(label, id)));
    if (entries.some(([id]) => id === value)) select.value = value;
  }
  function refresh(preview = false) {
    const creature = getCreature(), limbs = allLimbs(creature.parts);
    if (!limbs.some(part => part.id === selected)) { selected = limbs[0]?.id ?? ''; segmentIndex = 0; }
    options(select, limbs.map((part, index) => [part.id, `Limb ${index + 1}${part.parts.length ? ' · branched' : ''}`]), selected);
    find('#limb-count').textContent = `${limbs.length} ${limbs.length === 1 ? 'limb' : 'limbs'}`;
    find<HTMLFieldSetElement>('fieldset').disabled = preview;
    find('#limb-details').hidden = !selected;
    const part = limb();
    if (!part) return;
    const linked = creature.mirrorPairs.some(pair => pair.includes(part.id));
    find('#mirror-link-status').textContent = linked ? 'Mirrored pair. Edits and removal affect both sides.' : 'Single limb. Edits affect this side only.';
    find<HTMLButtonElement>('#limb-unlink').hidden = !linked;
    segmentIndex = Math.min(segmentIndex, part.segments.length - 1);
    options(segmentSelect, part.segments.map((_, index) => [String(index), `Segment ${index + 1}`]), String(segmentIndex));
    const segment = part.segments[segmentIndex];
    host.querySelectorAll<HTMLInputElement>('[data-segment-axis]').forEach(input => { if (document.activeElement !== input) input.value = metres(segment.position[Number(input.dataset.segmentAxis)]); });
    host.querySelectorAll<HTMLInputElement>('[data-socket-axis]').forEach(input => { if (document.activeElement !== input) input.value = metres(part.socket.position[Number(input.dataset.socketAxis)]); });
    const radius = find<HTMLInputElement>('#limb-radius');
    if (document.activeElement !== radius) radius.value = metres(segment.radius);
    find<HTMLSelectElement>('#limb-cap').value = part.cap ?? '';
    find<HTMLButtonElement>('#segment-remove').disabled = part.segments.length === 1;
  }
  function replace(change: (part: Limb) => void) {
    const current = limb(); if (!current) return;
    const part = structuredClone(current); change(part); mutate({ type: 'replace-limb', limb: part });
  }
  host.addEventListener('click', event => {
    const id = (event.target as HTMLElement).closest('button')?.id;
    if (id === 'limb-remove') mutate({ type: 'remove-limb', id: selected });
    else if (id === 'limb-unlink') mutate({ type: 'unlink', id: selected });
    else if (id === 'segment-add') replace(part => {
      const last = part.segments.at(-1)!;
      const previous = part.segments.at(-2);
      const position = last.position.map((value, axis) => value + (previous ? value - previous.position[axis] : axis === 1 ? -0.5 : 0)) as Position;
      part.segments.push({ ...structuredClone(last), id: crypto.randomUUID(), position }); segmentIndex = part.segments.length - 1;
    });
    else if (id === 'segment-remove') replace(part => {
      const removed = part.segments.splice(segmentIndex, 1)[0];
      part.parts = part.parts.filter(child => child.socket.sourceId !== removed.id);
    });
  }, { signal: listeners.signal });
  host.addEventListener('input', event => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.segmentAxis !== undefined || input.dataset.socketAxis !== undefined || input.id === 'limb-radius') {
      if (!Number.isFinite(input.valueAsNumber)) return;
      beginGesture();
      replace(part => {
        if (input.dataset.segmentAxis !== undefined) part.segments[segmentIndex].position[Number(input.dataset.segmentAxis)] = input.valueAsNumber;
        else if (input.dataset.socketAxis !== undefined) part.socket.position[Number(input.dataset.socketAxis)] = input.valueAsNumber;
        else part.segments[segmentIndex].radius = input.valueAsNumber;
      });
    }
  }, { signal: listeners.signal });
  host.addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    if (input.id === 'limb-select') { selected = input.value; segmentIndex = 0; refresh(); selectInViewport(limb()!.segments[segmentIndex].id); }
    else if (input.id === 'limb-segment') { segmentIndex = Number(input.value); refresh(); selectInViewport(limb()!.segments[segmentIndex].id); }
    else if (input.id === 'limb-cap') replace(part => { part.cap = input.value === '' ? null : input.value as Cap; });
    else if (input.type === 'number') endGesture();
  }, { signal: listeners.signal });
  host.addEventListener('focusout', event => { if ((event.target as HTMLInputElement).type === 'number') { endGesture(); refresh(); } }, { signal: listeners.signal });
  return { refresh, selectSegment(id: string) { const part = allLimbs(getCreature().parts).find(limb => limb.segments.some(segment => segment.id === id)); if (part) { selected = part.id; segmentIndex = part.segments.findIndex(segment => segment.id === id); refresh(); } }, dispose() { listeners.abort(); } };
}
