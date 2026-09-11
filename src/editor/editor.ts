import { applyMutation, createCreature } from '../creature/creature.ts';
import type { Creature, Mutation, Recipe, Position } from '../creature/creature.ts';
import { createViewer } from '../render/viewer.ts';
import type { MeshRequest, MeshResponse } from './mesh-worker.ts';
import type { Skin } from '../mesh/mesh.ts';

function element<T extends HTMLElement>(selector: string) {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing editor element ${selector}`);
  return found;
}

export function mountEditor() {
  const host = element('#viewport');
  const status = element('#status');
  const errorMessage = element('#error');
  let creature = createCreature();
  const base = structuredClone(creature);
  let mutations: Mutation[] = [];
  let undone: Mutation[][] = [];
  let history: Mutation[][] = [];
  let gestureBase: Creature | null = null;
  let gestureMutations: Mutation[] = [];
  let selected = creature.spine[2].id;
  let revision = 0;
  let busy = false;
  let queued: MeshRequest | null = null;
  let builds = 0;
  let latestSkin: Skin | null = null;
  let needsFrame = false;
  let disposed = false;
  const listeners = new AbortController();
  const radius = element<HTMLInputElement>('#radius');
  const radiusOutput = element<HTMLOutputElement>('#radius-output');
  const resolution = element<HTMLSelectElement>('#resolution');
  const smoothing = element<HTMLInputElement>('#smoothing');
  const preview = element<HTMLInputElement>('#preview-pose');
  const bend = element<HTMLInputElement>('#bend');
  const sweep = element<HTMLInputElement>('#sweep');
  const list = element('#vertebrae');
  const coordinates = ['x', 'y', 'z'].map(axis => element<HTMLInputElement>(`#position-${axis}`));
  const viewer = createViewer(host, {
    select: selectVertebra,
    begin: beginGesture,
    end: endGesture,
    move: (id, position) => mutate({ type: 'move', id, position }),
  });
  const worker = new Worker(new URL('./mesh-worker.ts', import.meta.url), { type: 'module' });

  function reportError(message: string) {
    errorMessage.textContent = message;
    errorMessage.hidden = false;
    status.textContent = 'Needs attention';
  }
  function dispatch() {
    if (busy || !queued || disposed) return;
    busy = true;
    const request = queued;
    queued = null;
    worker.postMessage(request);
  }
  function remesh() {
    latestSkin = null;
    errorMessage.hidden = true;
    status.textContent = 'Shaping…';
    queued = { revision: ++revision, creature, resolution: Number(resolution.value), smoothing: Number(smoothing.value) };
    dispatch();
  }
  worker.onmessage = (event: MessageEvent<MeshResponse>) => {
    busy = false;
    const response = event.data;
    if (!('error' in response) && response.meshed) builds++;
    element('#builds').textContent = String(builds);
    if (response.revision === revision) {
      if ('error' in response) reportError(response.error);
      else {
        latestSkin = response.skin;
        const discarded = viewer.setSkin(response.skin, response.rig);
        element('#bone-count').textContent = `${response.rig.bones.length} ${response.rig.bones.length === 1 ? 'bone' : 'bones'}`;
        element('#bind-time').textContent = `${response.bindMilliseconds.toFixed(1)} ms`;
        element('#discarded').textContent = `${(discarded * 100).toFixed(2)}%`;
        status.textContent = 'Ready';
        element('#triangles').textContent = (response.skin.triangles.length / 3).toLocaleString();
        if (response.meshed) element('#mesh-time').textContent = `${response.milliseconds.toFixed(1)} ms`;
        element('#cell-size').textContent = `${response.skin.cellSize.toFixed(3)} m`;
        if (needsFrame) { viewer.frameCreature(); needsFrame = false; }
      }
    }
    dispatch();
  };
  worker.onerror = event => { busy = false; reportError(event.message || 'The mesher could not start.'); };

  function updateControls(rebuildList = false) {
    const vertebra = creature.spine.find(item => item.id === selected)!;
    viewer.setCreature(creature, selected);
    element('#selected-label').textContent = `Vertebra ${creature.spine.indexOf(vertebra) + 1}`;
    element('#spine-count').textContent = `${creature.spine.length} ${creature.spine.length === 1 ? 'vertebra' : 'vertebrae'}`;
    radius.value = String(vertebra.radius);
    radiusOutput.value = `${vertebra.radius.toFixed(2)} m`;
    coordinates.forEach((input, axis) => { if (document.activeElement !== input) input.value = vertebra.position[axis].toFixed(2); });
    if (rebuildList) {
      list.replaceChildren(...creature.spine.map((item, index) => {
        const button = document.createElement('button');
        button.textContent = String(index + 1).padStart(2, '0');
        button.dataset.id = item.id;
        button.setAttribute('aria-label', `Select vertebra ${index + 1}`);
        return button;
      }));
    }
    list.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.id === selected)));
    element<HTMLButtonElement>('#remove').disabled = creature.spine.length === 1 || preview.checked;
    element<HTMLButtonElement>('#undo').disabled = history.length === 0;
    element<HTMLButtonElement>('#redo').disabled = undone.length === 0;
    document.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color === creature.skinColor)));
  }
  function updatePreview() {
    viewer.preview(preview.checked ? Number(bend.value) * Math.PI / 180 : null, sweep.checked);
    element<HTMLOutputElement>('#bend-output').value = `${bend.value}°`;
    bend.disabled = !preview.checked;
    sweep.disabled = !preview.checked;
    radius.disabled = preview.checked;
    coordinates.forEach(input => { input.disabled = preview.checked; });
    element<HTMLButtonElement>('#add').disabled = preview.checked;
    element('#viewport-hint').textContent = preview.checked ? 'Inspect the bend. The skin stays bound.' : 'Pull a point. Change a creature.';
    element('#viewport-help').textContent = preview.checked ? 'Use Bend to pose · Drag the background to orbit · Return to shaping to edit' : 'Drag a vertebra to shape · Drag the background to orbit · Scroll to zoom';
    updateControls();
  }
  function selectVertebra(id: string) { selected = id; updateControls(); }
  function beginGesture() { if (!gestureBase) { gestureBase = structuredClone(creature); gestureMutations = []; } }
  function endGesture() {
    if (!gestureBase) return;
    if (gestureMutations.length) {
      history.push(gestureMutations);
      mutations.push(...gestureMutations);
      undone = [];
    }
    gestureBase = null;
    gestureMutations = [];
    updateControls();
  }
  function mutate(mutation: Mutation) {
    try {
      if (preview.checked && mutation.type !== 'color') { preview.checked = false; updatePreview(); }
      const next = applyMutation(creature, mutation);
      creature = next;
      if (gestureBase) {
        // A drag or slider gesture is one recipe mutation and one undo step.
        gestureMutations = [mutation];
      } else {
        history.push([mutation]);
        mutations.push(mutation);
        undone = [];
      }
      updateControls(mutation.type === 'insert' || mutation.type === 'remove');
      if (mutation.type !== 'color') remesh();
    } catch (error) {
      reportError(error instanceof Error ? error.message : 'Could not change the creature.');
      updateControls();
    }
  }
  function restoreHistory() {
    preview.checked = false;
    updatePreview();
    mutations = history.flat();
    creature = mutations.reduce(applyMutation, structuredClone(base));
    if (!creature.spine.some(item => item.id === selected)) selected = creature.spine[0].id;
    updateControls(true);
    remesh();
  }
  function on<K extends keyof HTMLElementEventMap>(target: HTMLElement, name: K, listener: (event: HTMLElementEventMap[K]) => void) {
    target.addEventListener(name, listener, { signal: listeners.signal });
  }
  on(list, 'click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-id]');
    if (button?.dataset.id) selectVertebra(button.dataset.id);
  });
  on(radius, 'pointerdown', beginGesture);
  on(radius, 'input', () => { beginGesture(); mutate({ type: 'radius', id: selected, radius: Number(radius.value) }); });
  on(radius, 'change', endGesture);
  on(radius, 'blur', endGesture);
  coordinates.forEach((input, axis) => {
    on(input, 'input', () => {
      // Empty text and a lone minus sign are normal intermediate input states.
      if (!Number.isFinite(input.valueAsNumber)) return;
      beginGesture();
      const position: Position = [...creature.spine.find(item => item.id === selected)!.position];
      position[axis] = input.valueAsNumber;
      mutate({ type: 'move', id: selected, position });
    });
    on(input, 'change', endGesture);
    on(input, 'blur', () => { endGesture(); updateControls(); });
  });
  on(element('#add'), 'click', () => {
    const index = creature.spine.findIndex(item => item.id === selected);
    const a = creature.spine[index];
    const b = creature.spine[index + 1];
    const id = crypto.randomUUID();
    const position: Position = b ? a.position.map((v, axis) => (v + b.position[axis]) / 2) as Position : [a.position[0] + a.radius * 1.5, a.position[1], a.position[2]];
    const mutation: Mutation = { type: 'insert', after: selected, vertebra: { id, position, radius: b ? (a.radius + b.radius) / 2 : Math.max(0.1, a.radius * 0.85), orientation: [...a.orientation] } };
    mutate(mutation);
    selectVertebra(id);
  });
  on(element('#remove'), 'click', () => {
    const id = selected;
    selected = creature.spine.find(item => item.id !== id)!.id;
    mutate({ type: 'remove', id });
  });
  on(element('#undo'), 'click', () => { endGesture(); const step = history.pop(); if (step) { undone.push(step); restoreHistory(); } });
  on(element('#redo'), 'click', () => { const step = undone.pop(); if (step) { history.push(step); restoreHistory(); } });
  on(element('#reset'), 'click', () => {
    preview.checked = false;
    sweep.checked = false;
    updatePreview();
    gestureBase = null;
    gestureMutations = [];
    history = []; undone = []; mutations = [];
    creature = structuredClone(base); selected = creature.spine[2].id;
    needsFrame = true;
    updateControls(true); remesh();
  });
  on(element('#frame'), 'click', () => viewer.frameCreature());
  on(element<HTMLInputElement>('#wireframe'), 'change', event => viewer.wireframe((event.target as HTMLInputElement).checked));
  on(element<HTMLInputElement>('#show-spine'), 'change', event => viewer.showSpine((event.target as HTMLInputElement).checked));
  on(resolution, 'change', remesh);
  on(preview, 'change', () => { endGesture(); updatePreview(); });
  on(bend, 'input', updatePreview);
  on(sweep, 'change', updatePreview);
  on(smoothing, 'input', () => {
    element<HTMLOutputElement>('#smoothing-output').value = smoothing.value === '0' ? 'Raw' : `${smoothing.value} passes`;
    if (!latestSkin) { remesh(); return; }
    status.textContent = 'Binding…';
    queued = { revision: ++revision, creature, resolution: Number(resolution.value), smoothing: Number(smoothing.value), skin: latestSkin };
    dispatch();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(button => on(button, 'click', () => mutate({ type: 'color', color: button.dataset.color! })));
  on(element('#save'), 'click', () => {
    endGesture();
    const recipe: Recipe = { base, mutations };
    const url = URL.createObjectURL(new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'creature.recipe.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  updateControls(true);
  updatePreview();
  remesh();
  return () => { disposed = true; listeners.abort(); worker.terminate(); viewer.dispose(); };
}
