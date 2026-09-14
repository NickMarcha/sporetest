import { applyMutation, createCreature, parseRecipe, replayRecipe } from '../creature/creature.ts';
import type { Creature, Mutation, Recipe, Position } from '../creature/creature.ts';
import { createViewer, walkAroundTempo } from '../render/viewer.ts';
import type { MeshRequest, MeshResponse } from './mesh-worker.ts';
import type { Skin } from '../mesh/mesh.ts';
import { mountLimbEditor } from './limb-editor.ts';
import { createAttachedLimb, moveLimbSegment } from '../creature/attachment.ts';
import type { LimbPreset } from '../creature/attachment.ts';
import type { PlacementTool } from '../render/placement.ts';
import { defaultGaitSettings } from '../anim/gait.ts';
import type { Balance } from '../anim/balance.ts';
import { bindPreviewURL } from './preview-url.ts';

function element<T extends HTMLElement>(selector: string) {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing editor element ${selector}`);
  return found;
}

export function mountEditor() {
  const host = element('#viewport');
  const status = element('#status');
  const errorMessage = element('#error');
  const localSave = element('#local-save');
  const storageKey = 'sporetest.current-recipe';
  let restored: Recipe | null = null;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) { restored = parseRecipe(saved); localSave.textContent = 'Restored from this browser'; }
  } catch {
    localSave.textContent = 'Could not restore local save. Load a recipe to recover it.';
  }
  let creature = restored ? replayRecipe(restored) : createCreature();
  let base = structuredClone(restored?.base ?? creature);
  let mutations: Mutation[] = restored?.mutations ?? [];
  let undone: Mutation[][] = [];
  let history: Mutation[][] = mutations.map(mutation => [mutation]);
  let gestureBase: Creature | null = null;
  let gestureMutations: Mutation[] = [];
  let selected = creature.spine[Math.min(2, creature.spine.length - 1)].id;
  let selectedSegment: string | null = null;
  let placementTool: PlacementTool | null = null;
  let standingPreview = false;
  let walkingPreview = false;
  let roamSpeed = 1;
  let revision = 0;
  let busy = false;
  let queued: MeshRequest | null = null;
  let builds = 0;
  let latestSkin: Skin | null = null;
  let needsFrame = restored !== null;
  let disposed = false;
  const listeners = new AbortController();
  const radius = element<HTMLInputElement>('#radius');
  const radiusOutput = element<HTMLOutputElement>('#radius-output');
  const resolution = element<HTMLSelectElement>('#resolution');
  const smoothing = element<HTMLInputElement>('#smoothing');
  const preview = element<HTMLInputElement>('#preview-pose');
  const ikPreview = element<HTMLInputElement>('#ik-preview');
  const bend = element<HTMLInputElement>('#bend');
  const sweep = element<HTMLInputElement>('#sweep');
  const limbBend = element<HTMLInputElement>('#limb-bend');
  const list = element('#vertebrae');
  const coordinates = ['x', 'y', 'z'].map(axis => element<HTMLInputElement>(`#position-${axis}`));
  const viewer = createViewer(host, {
    performanceHint: (fps, cpu, pose, draw, gpu, worst, input) => {
      element('#motion-performance').textContent = `${fps.toFixed(0)} fps · Frame CPU ${cpu.toFixed(1)} ms · Pose ${pose.toFixed(1)} ms · Draw submission ${draw.toFixed(1)} ms · GPU ${gpu < 0 ? 'unavailable' : `${gpu.toFixed(1)} ms`} · Worst frame gap ${worst.toFixed(1)} ms · Key handler to frame submission ${input < 0 ? 'not sampled' : `${input.toFixed(1)} ms`}`;
    },
    walkingHint: (grounded, planted, error, unsupported, seconds, gait, balance, transfer) => {
      if (!walkingPreview) return;
      const around = element<HTMLInputElement>('#walk-around').checked;
      element('#viewport-hint').textContent = `${grounded}/${planted} planted feet holding contact`;
      element('#viewport-help').textContent = `Contact error ${error.toFixed(3)} m${unsupported ? ` · ${unsupported} feet have no skin contact patch` : ''} · ${around ? 'Click area · W/S move · A/D strafe · Right-drag turns' : 'Camera follows travel'} · Orange rings mark misses · Shape to edit`;
      element('#roam-position').textContent = `Travel ${gait.rootTravel[0].toFixed(2)}, ${gait.rootTravel[2].toFixed(2)} m · Heading ${(gait.yaw * 180 / Math.PI).toFixed(0)}°`;
      const timeline = element<HTMLInputElement>('#walk-time');
      timeline.max = String(Math.max(Number(timeline.max), Math.ceil(seconds / 30) * 30));
      timeline.value = String(seconds);
      element<HTMLOutputElement>('#walk-time-output').value = `${seconds.toFixed(3)} s`;
      element('#walk-motion').textContent = gait.moving ? 'Stop walking' : 'Start walking';
      element('#walk-motion-status').textContent = gait.motion === 'settling' ? gait.settlingRemaining ? `Settling · ${gait.settlingRemaining} step${gait.settlingRemaining === 1 ? '' : 's'} left` : 'Settling · easing torso' : gait.motion[0].toUpperCase() + gait.motion.slice(1);
      const factor = around ? roamSpeed : gait.speed > 0 ? gait.targetSpeed / gait.speed : 0;
      element<HTMLInputElement>('#walk-speed').value = String(factor);
      const speed = around ? Math.hypot(gait.currentSpeed, gait.currentSideX, gait.currentSideZ) : gait.currentSpeed;
      element<HTMLOutputElement>('#walk-speed-output').value = `${factor.toFixed(2)}× · ${speed.toFixed(3)} m/s`;
      element<HTMLInputElement>('#gait-period').value = String(gait.groups[0]?.period ?? defaultGaitSettings.period / gait.tempo);
      element<HTMLOutputElement>('#gait-period-output').value = `${(gait.groups[0]?.period ?? defaultGaitSettings.period / gait.tempo).toFixed(2)} s`;
      const turnDegrees = -gait.targetTurnRate * 180 / Math.PI;
      element<HTMLInputElement>('#walk-turn').value = String(turnDegrees);
      element<HTMLOutputElement>('#walk-turn-output').value = Math.abs(turnDegrees) < 0.01 ? 'Straight' : `${Math.abs(turnDegrees).toFixed(0)}°/s ${turnDegrees < 0 ? 'left' : 'right'}`;
      updateBalanceHint(balance);
      element('#walk-transfer-status').textContent = Number(element<HTMLInputElement>('#walk-transfer').value) === 0 ? 'Weight transfer off.' : `Torso shift ${transfer.toFixed(3)} m · Planted contact error ${error.toFixed(3)} m`;
    },
    select: id => {
      if (creature.spine.some(vertebra => vertebra.id === id)) selectVertebra(id);
      else { selectedSegment = id; limbEditor.selectSegment(id); updateControls(); }
    },
    begin: beginGesture,
    end: endGesture,
    move: (id, position) => mutate(creature.spine.some(vertebra => vertebra.id === id) ? { type: 'move', id, position } : moveLimbSegment(creature, id, position)),
    place: hits => {
      if (!placementTool) return;
      const limbs = hits.map(hit => createAttachedLimb(creature, hit, placementTool!.kind, () => crypto.randomUUID()));
      mutate(limbs.length === 2 ? { type: 'attach-pair', limbs: [limbs[0], limbs[1]] } : { type: 'attach', limb: limbs[0] });
      selectedSegment = limbs[0].segments[0].id;
      limbEditor.selectSegment(selectedSegment);
      setPlacement(null);
    },
    placementHint: count => {
      if (placementTool) element('#placement-hint').textContent = count === 2 ? 'Click to place a pair' : count === 1 ? 'Click to place one' : 'Move over the skin · Esc to cancel';
    },
  });
  const worker = new Worker(new URL('./mesh-worker.ts', import.meta.url), { type: 'module' });
  const limbEditor = mountLimbEditor(element('#limbs'), () => creature, mutate, beginGesture, endGesture, id => { selectedSegment = id; updateControls(); });

  function reportError(message: string) {
    errorMessage.textContent = message;
    errorMessage.hidden = false;
    status.textContent = 'Needs attention';
  }
  function updateBalanceHint(balance: Balance) {
    element('#balance-feet').textContent = `${balance.supportingFeet} supporting ${balance.supportingFeet === 1 ? 'foot' : 'feet'}`;
    element('#balance-status').textContent = !balance.available ? 'No skin area to estimate mass.' : !balance.hullCount ? 'No planted foot contact with the floor.'
      : balance.inside ? balance.hullCount < 3 ? 'Centre projection meets a point or line contact.' : 'Centre projection is inside the support area.'
        : `Centre projection is ${balance.distance < 0.001 ? 'less than 0.001' : balance.distance.toFixed(3)} m outside the support area.`;
  }
  function saveLocal() {
    try {
      const recipe: Recipe = { base, mutations: gestureBase ? [...mutations, ...gestureMutations] : mutations };
      localStorage.setItem(storageKey, JSON.stringify(recipe));
      localSave.textContent = 'Saved in this browser';
    } catch {
      localSave.textContent = 'Local save failed. Use Save recipe to keep your creature.';
    }
  }
  function dispatch() {
    if (busy || !queued || disposed) return;
    busy = true;
    const request = queued;
    queued = null;
    worker.postMessage(request);
  }
  function remesh() {
    viewer.skinPending();
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
        ikPreview.disabled = false;
        element<HTMLButtonElement>('#tool-ik').disabled = ikPreview.disabled;
        element<HTMLButtonElement>('#tool-stand').disabled = !response.rig.bones.some(bone => bone.cap === 'foot');
        element<HTMLButtonElement>('#tool-walk').disabled = element<HTMLButtonElement>('#tool-stand').disabled;
        if (standingPreview || walkingPreview) updatePreview();
        element('#bind-time').textContent = `${response.bindMilliseconds.toFixed(1)} ms`;
        element('#discarded').textContent = `${(discarded * 100).toFixed(2)}%`;
        status.textContent = 'Ready';
        element('#triangles').textContent = (response.skin.triangles.length / 3).toLocaleString();
        if (response.meshed) element('#mesh-time').textContent = `${response.milliseconds.toFixed(1)} ms`;
        element('#cell-size').textContent = `${response.skin.cellSize.toFixed(3)} m`;
        if (needsFrame) { viewer.frameCreature(); needsFrame = false; }
        restorePreviewURL();
      }
    }
    dispatch();
  };
  worker.onerror = event => { busy = false; reportError(event.message || 'The mesher could not start.'); };

  function updateControls(rebuildList = false) {
    const vertebra = creature.spine.find(item => item.id === selected)!;
    viewer.setCreature(creature, selectedSegment ?? selected);
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
    element<HTMLButtonElement>('#remove').disabled = creature.spine.length === 1 || preview.checked || ikPreview.checked;
    element<HTMLButtonElement>('#align-spine').disabled = preview.checked || ikPreview.checked || creature.spine.every(vertebra => vertebra.position[2] === 0);
    element<HTMLButtonElement>('#undo').disabled = history.length === 0;
    element<HTMLButtonElement>('#redo').disabled = undone.length === 0;
    document.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color === creature.skinColor)));
    limbEditor.refresh(preview.checked || ikPreview.checked);
  }
  function updatePreview() {
    if (preview.checked || ikPreview.checked) placementTool = null;
    updatePlacementControls();
    viewer.preview(preview.checked ? Number(bend.value) * Math.PI / 180 : null, sweep.checked, Number(limbBend.value) * Math.PI / 180);
    viewer.ik(ikPreview.checked && !standingPreview && !walkingPreview);
    const strength = Number(element<HTMLInputElement>('#stand-strength').value);
    const maximumShift = Number(element<HTMLInputElement>('#stand-shift').value);
    const standing = viewer.stand(standingPreview, strength, maximumShift);
    viewer.walk(walkingPreview);
    if (!walkingPreview) element<HTMLInputElement>('#walk-around').checked = false;
    updateRoamControls();
    element('#gait-controls').hidden = !walkingPreview;
    element('#balance-controls').hidden = !walkingPreview && !standingPreview;
    element('#standing-correction').hidden = !standingPreview;
    element<HTMLOutputElement>('#stand-strength-output').value = `${Math.round(strength * 100)}%`;
    element<HTMLOutputElement>('#stand-shift-output').value = `${maximumShift.toFixed(2)} m`;
    if (standing) element('#stand-correction-status').textContent = strength === 0 ? 'Correction off. Increase strength to shift the torso toward support.'
      : !Number.isFinite(standing.correctionBefore) ? 'No foot support available for correction.'
      : `Torso shift ${standing.correctionShift.toFixed(3)} m · Outside support ${standing.correctionBefore.toFixed(3)} → ${standing.balance.distance.toFixed(3)} m · Sole drift ${standing.anchorError.toFixed(3)} m`;
    if (standing) updateBalanceHint(standing.balance);
    element<HTMLOutputElement>('#limb-bend-output').value = `${limbBend.value}°`;
    limbBend.disabled = !preview.checked;
    element<HTMLOutputElement>('#bend-output').value = `${bend.value}°`;
    bend.disabled = !preview.checked;
    sweep.disabled = !preview.checked;
    radius.disabled = preview.checked || ikPreview.checked;
    coordinates.forEach(input => { input.disabled = preview.checked || ikPreview.checked; });
    element<HTMLButtonElement>('#add').disabled = preview.checked || ikPreview.checked;
    element('#viewport-hint').textContent = walkingPreview ? 'Walking…' : standing ? `${standing.grounded}/${standing.total} feet touching the floor` : ikPreview.checked ? 'Reach for a target.' : preview.checked ? 'Inspect the bend. The skin stays bound.' : 'Pull a point. Change a creature.';
    element('#viewport-help').textContent = walkingPreview ? 'Camera follows travel · Shape to edit' : standing ? `Largest contact error ${standing.error.toFixed(3)} m · Green rings mark contact · Walk to try stepping` : ikPreview.checked ? 'Drag orange targets to pose · Drag the background to orbit · Shape returns to editing' : preview.checked ? 'Use Bend to pose · Drag the background to orbit · Return to shaping to edit' : 'Drag a point to shape · Drag the background to orbit · Scroll to zoom';
    updateControls();
  }
  function selectVertebra(id: string) { selected = id; selectedSegment = null; updateControls(); }
  function updateRoamControls() {
    const around = element<HTMLInputElement>('#walk-around').checked;
    element('#roam-controls').hidden = !around;
    for (const id of ['#walk-turn', '#walk-straight', '#walk-motion']) element<HTMLInputElement | HTMLButtonElement>(id).disabled = around;
  }
  function updatePlacementControls() {
    viewer.placement(placementTool);
    for (const mode of ['shape', 'arm', 'leg', 'tail', 'ik', 'stand', 'walk']) element(`#tool-${mode}`).setAttribute('aria-pressed', String(mode === (walkingPreview ? 'walk' : standingPreview ? 'stand' : ikPreview.checked ? 'ik' : preview.checked ? 'preview' : placementTool?.kind ?? 'shape')));
    element<HTMLInputElement>('#mirror-placement').disabled = !placementTool;
    element('#placement-hint').textContent = walkingPreview ? 'Walking · Shape to edit' : standingPreview ? 'Inspect foot contact · Shape to edit' : ikPreview.checked ? 'Drag orange targets to pose' : preview.checked ? 'Inspect the bend' : placementTool ? 'Move over the skin · Esc to cancel' : 'Drag points to shape';
  }
  function setPlacement(kind: LimbPreset | null) {
    endGesture();
    walkingPreview = false;
    standingPreview = false;
    if (preview.checked || ikPreview.checked) { preview.checked = false; ikPreview.checked = false; updatePreview(); }
    placementTool = kind ? { kind, mirror: kind === 'leg' } : null;
    element<HTMLInputElement>('#mirror-placement').checked = placementTool?.mirror ?? false;
    updatePlacementControls(); updateControls();
  }
  function beginGesture() { if (!gestureBase) { gestureBase = structuredClone(creature); gestureMutations = []; } }
  function endGesture() {
    if (!gestureBase) return;
    const changed = gestureMutations.length > 0;
    if (gestureMutations.length) {
      history.push(gestureMutations);
      mutations.push(...gestureMutations);
      undone = [];
    }
    gestureBase = null;
    gestureMutations = [];
    if (changed) saveLocal();
    updateControls();
  }
  function mutate(change: Mutation | Mutation[]) {
    const changes = Array.isArray(change) ? change : [change];
    try {
      if ((preview.checked || ikPreview.checked) && changes.some(mutation => mutation.type !== 'color')) { preview.checked = false; ikPreview.checked = false; standingPreview = false; walkingPreview = false; updatePreview(); }
      const next = changes.reduce(applyMutation, creature);
      creature = next;
      if (gestureBase) {
        // A drag or slider gesture is one recipe mutation and one undo step.
        gestureMutations = changes;
      } else {
        history.push(changes);
        mutations.push(...changes);
        undone = [];
        saveLocal();
      }
      updateControls(changes.some(mutation => mutation.type === 'insert' || mutation.type === 'remove'));
      if (changes.some(mutation => mutation.type !== 'color')) remesh();
    } catch (error) {
      reportError(error instanceof Error ? error.message : 'Could not change the creature.');
      updateControls();
    }
  }
  function restoreHistory() {
    walkingPreview = false;
    standingPreview = false;
    selectedSegment = null;
    placementTool = null; updatePlacementControls();
    preview.checked = false;
    ikPreview.checked = false;
    updatePreview();
    mutations = history.flat();
    creature = mutations.reduce(applyMutation, structuredClone(base));
    saveLocal();
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
  for (const kind of ['arm', 'leg', 'tail'] as const) on(element(`#tool-${kind}`), 'click', () => setPlacement(kind));
  on(element('#tool-shape'), 'click', () => setPlacement(null));
  on(element('#tool-ik'), 'click', () => { endGesture(); ikPreview.checked = standingPreview || walkingPreview || !ikPreview.checked; standingPreview = false; walkingPreview = false; preview.checked = false; updatePreview(); });
  on(element('#tool-stand'), 'click', () => { endGesture(); standingPreview = !standingPreview; walkingPreview = false; ikPreview.checked = standingPreview; preview.checked = false; updatePreview(); });
  on(element('#tool-walk'), 'click', () => {
    endGesture();
    if (walkingPreview) { viewer.toggleWalk(); return; }
    walkingPreview = true; standingPreview = false; ikPreview.checked = true; preview.checked = false; updatePreview();
  });
  on(element('#walk-motion'), 'click', () => viewer.toggleWalk());
  on(element<HTMLInputElement>('#show-performance'), 'change', event => {
    const enabled = (event.target as HTMLInputElement).checked;
    element('#motion-performance').hidden = !enabled; viewer.showPerformance(enabled);
  });
  on(element<HTMLInputElement>('#walk-speed'), 'input', event => {
    const factor = Number((event.target as HTMLInputElement).value);
    if (element<HTMLInputElement>('#walk-around').checked) roamSpeed = factor;
    viewer.speedWalk(factor);
  });
  on(element<HTMLInputElement>('#walk-turn'), 'input', event => viewer.turnWalk(-Number((event.target as HTMLInputElement).value) * Math.PI / 180));
  on(element('#walk-straight'), 'click', () => viewer.turnWalk(0));
  on(element<HTMLInputElement>('#walk-around'), 'change', event => {
    playback(false); viewer.walkAround((event.target as HTMLInputElement).checked); updateRoamControls();
  });
  for (const [id, forward, left] of [['#roam-forward', 1, 0], ['#roam-reverse', -1, 0], ['#roam-left', 0, 1], ['#roam-right', 0, -1], ['#roam-stop', 0, 0]] as const) {
    on(element(id), 'click', () => { playback(false); viewer.driveWalk(forward, left); });
  }
  const gaitDuty = element<HTMLInputElement>('#gait-duty');
  const gaitPeriod = element<HTMLInputElement>('#gait-period');
  const gaitLift = element<HTMLInputElement>('#gait-lift');
  const walkRate = element<HTMLSelectElement>('#walk-rate');
  const walkPause = element<HTMLButtonElement>('#walk-pause');
  let walkPaused = false;
  function tuneGait() {
    const settings = { duty: Number(gaitDuty.value), period: Number(gaitPeriod.value), lift: Number(gaitLift.value) };
    viewer.tuneWalk(settings);
    element<HTMLOutputElement>('#gait-duty-output').value = `${Math.round(settings.duty * 100)}% planted`;
    element<HTMLOutputElement>('#gait-period-output').value = `${settings.period.toFixed(2)} s`;
    element<HTMLOutputElement>('#gait-lift-output').value = `${Math.round(settings.lift * 100)}% leg length`;
  }
  function playback(paused = walkPaused) {
    walkPaused = paused;
    walkPause.textContent = paused ? 'Play' : 'Pause';
    viewer.walkPlayback(paused, Number(walkRate.value));
  }
  for (const input of [gaitDuty, gaitPeriod, gaitLift]) on(input, 'input', tuneGait);
  on(element('#gait-reset'), 'click', () => {
    gaitDuty.value = String(defaultGaitSettings.duty);
    gaitPeriod.value = String(defaultGaitSettings.period / (element<HTMLInputElement>('#walk-around').checked ? walkAroundTempo : 1));
    gaitLift.value = String(defaultGaitSettings.lift);
    tuneGait();
  });
  on(walkPause, 'click', () => playback(!walkPaused));
  on(walkRate, 'change', () => playback());
  on(element('#walk-step'), 'click', () => { playback(true); viewer.stepWalk(); });
  on(element('#walk-restart'), 'click', () => viewer.seekWalk(0));
  on(element<HTMLInputElement>('#walk-time'), 'input', event => {
    playback(true); viewer.seekWalk(Number((event.target as HTMLInputElement).value));
  });
  on(element<HTMLInputElement>('#walk-targets'), 'change', event => viewer.showFootTargets((event.target as HTMLInputElement).checked));
  on(element<HTMLInputElement>('#show-balance'), 'change', event => viewer.showBalance((event.target as HTMLInputElement).checked));
  for (const id of ['walk-lean', 'walk-sway']) on(element<HTMLInputElement>(`#${id}`), 'input', () => {
    const lean = Number(element<HTMLInputElement>('#walk-lean').value), sway = Number(element<HTMLInputElement>('#walk-sway').value);
    viewer.reactionWalk(lean, sway);
    element<HTMLOutputElement>('#walk-lean-output').value = `${Math.round(lean * 100)}%`;
    element<HTMLOutputElement>('#walk-sway-output').value = `${Math.round(sway * 100)}%`;
  });
  on(element<HTMLInputElement>('#walk-head'), 'input', event => {
    const strength = Number((event.target as HTMLInputElement).value);
    viewer.headWalk(strength);
    element<HTMLOutputElement>('#walk-head-output').value = `${Math.round(strength * 100)}%`;
  });
  on(element<HTMLInputElement>('#walk-tail'), 'input', event => {
    const strength = Number((event.target as HTMLInputElement).value);
    viewer.tailWalk(strength);
    element<HTMLOutputElement>('#walk-tail-output').value = `${Math.round(strength * 100)}%`;
  });
  on(element<HTMLInputElement>('#walk-body'), 'input', event => {
    const strength = Number((event.target as HTMLInputElement).value);
    viewer.bodyWalk(strength);
    element<HTMLOutputElement>('#walk-body-output').value = `${Math.round(strength * 100)}%`;
  });
  for (const id of ['#walk-transfer', '#walk-transfer-limit']) on(element<HTMLInputElement>(id), 'input', () => {
    const strength = Number(element<HTMLInputElement>('#walk-transfer').value), limit = Number(element<HTMLInputElement>('#walk-transfer-limit').value);
    viewer.transferWalk(strength, limit);
    element<HTMLOutputElement>('#walk-transfer-output').value = `${Math.round(strength * 100)}%`;
    element<HTMLOutputElement>('#walk-transfer-limit-output').value = `${limit.toFixed(2)} m`;
  });
  for (const id of ['#stand-strength', '#stand-shift']) on(element<HTMLInputElement>(id), 'input', updatePreview);
  on(element<HTMLInputElement>('#mirror-placement'), 'change', event => {
    if (placementTool) { placementTool.mirror = (event.target as HTMLInputElement).checked; updatePlacementControls(); }
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && placementTool) setPlacement(null); }, { signal: listeners.signal });
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
  /** Replaces the whole document. Reset keeps the current base; Load brings a saved base and its mutations, each as one undo step. */
  function loadDocument(nextBase: Creature, nextMutations: Mutation[]) {
    walkingPreview = false;
    standingPreview = false;
    selectedSegment = null; placementTool = null; updatePlacementControls();
    preview.checked = false;
    ikPreview.checked = false;
    sweep.checked = false;
    updatePreview();
    gestureBase = null;
    gestureMutations = [];
    base = structuredClone(nextBase);
    history = nextMutations.map(mutation => [structuredClone(mutation)]); undone = []; mutations = history.flat();
    creature = mutations.reduce(applyMutation, structuredClone(base));
    saveLocal();
    selected = creature.spine[Math.min(2, creature.spine.length - 1)].id;
    needsFrame = true;
    updateControls(true); remesh();
  }
  on(element('#reset'), 'click', () => loadDocument(base, []));
  on(element('#frame'), 'click', () => viewer.frameCreature());
  on(element('#align-spine'), 'click', () => {
    endGesture();
    const changes: Mutation[] = creature.spine.filter(vertebra => vertebra.position[2] !== 0).map(vertebra => ({
      type: 'move', id: vertebra.id, position: [vertebra.position[0], vertebra.position[1], 0],
    }));
    if (changes.length) mutate(changes);
  });
  on(element<HTMLInputElement>('#wireframe'), 'change', event => viewer.wireframe((event.target as HTMLInputElement).checked));
  on(element<HTMLInputElement>('#show-spine'), 'change', event => viewer.showSpine((event.target as HTMLInputElement).checked));
  on(resolution, 'change', remesh);
  on(preview, 'change', () => { endGesture(); standingPreview = false; walkingPreview = false; if (preview.checked) ikPreview.checked = false; updatePreview(); });
  on(ikPreview, 'change', () => { endGesture(); standingPreview = false; walkingPreview = false; if (ikPreview.checked) preview.checked = false; updatePreview(); });
  on(bend, 'input', updatePreview);
  on(limbBend, 'input', updatePreview);
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
  const recipeFile = element<HTMLInputElement>('#recipe-file');
  on(element('#load'), 'click', () => { endGesture(); recipeFile.value = ''; recipeFile.click(); });
  on(recipeFile, 'change', async () => {
    const file = recipeFile.files?.[0];
    if (!file) return;
    try {
      const recipe = parseRecipe(await file.text());
      if (disposed) return;
      loadDocument(recipe.base, recipe.mutations);
    } catch (error) {
      reportError(error instanceof Error ? error.message : 'Could not read the recipe.');
    }
  });
  const savePendingGesture = () => { if (gestureMutations.length) saveLocal(); };
  window.addEventListener('pagehide', savePendingGesture, { signal: listeners.signal });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePendingGesture(); }, { signal: listeners.signal });
  updateControls(true);
  updatePlacementControls();
  updatePreview();
  const restorePreviewURL = bindPreviewURL(listeners.signal, () => walkingPreview ? 'walk' : standingPreview ? 'stand' : 'shape', walkAroundTempo);
  remesh();
  return () => { disposed = true; listeners.abort(); limbEditor.dispose(); worker.terminate(); viewer.dispose(); };
}
