import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Creature, Position } from '../creature/creature.ts';
import type { Skin } from '../mesh/mesh.ts';
import type { Rig } from '../rig/rig.ts';
import { createRigView } from './rig-view.ts';
import { resolveStructure } from '../creature/structure.ts';
import type { AttachmentPoint } from '../creature/attachment.ts';
import { createPlacementPreview } from './placement.ts';
import type { PlacementTool } from './placement.ts';
import { defaultGaitSettings } from '../anim/gait.ts';
import type { Gait, GaitSettings } from '../anim/gait.ts';
import type { Balance } from '../anim/balance.ts';
import { createBalanceView } from './balance-view.ts';

export const walkAroundTempo = 3;

export function createViewer(host: HTMLElement, events: {
  select: (id: string) => void;
  move: (id: string, position: Position) => void;
  begin: () => void;
  end: () => void;
  place: (hits: AttachmentPoint[]) => void;
  placementHint: (count: number) => void;
  performanceHint: (fps: number, cpu: number, pose: number, draw: number, gpu: number, worst: number, input: number) => void;
  walkingHint: (grounded: number, planted: number, error: number, unsupported: number, seconds: number, gait: Gait, balance: Balance, transfer: number) => void;
}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor('#eaece5', 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.setAttribute('aria-label', 'Creature viewport. Drag a vertebra to shape the spine. Drag empty space to orbit.');
  // This Three.js renderer requires WebGL 2; its installed declaration still includes WebGL 1.
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const gpuTimer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  let gpuQuery: WebGLQuery | null = null, gpuPending = false, gpuTime = 0, gpuSamples = 0;
  host.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const walkingFrame = new THREE.Group(); scene.add(walkingFrame);
  const balanceView = createBalanceView(walkingFrame);
  const placement = createPlacementPreview(scene);
  let placementTool: PlacementTool | null = null;
  let skinReady = false;
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 500);
  camera.position.set(4.4, 3.2, 7.3);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.09;
  orbit.minDistance = 0.5;
  orbit.maxDistance = 100;
  scene.add(new THREE.HemisphereLight('#ffffff', '#8a9985', 1.8));
  const key = new THREE.DirectionalLight('#fff5e4', 2.8);
  key.position.set(-3, 6, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight('#d7e9e7', 1.8);
  fill.position.set(4, 1, -4);
  scene.add(fill);
  const material = new THREE.MeshStandardMaterial({ color: '#91ae9e', roughness: 0.67, metalness: 0.02 });
  let rigView: ReturnType<typeof createRigView> | null = null;
  const grid = new THREE.GridHelper(30, 30, '#bac1b6', '#d1d6cb');
  grid.position.y = -1.05;
  grid.material.transparent = true;
  grid.material.opacity = 0.25;
  scene.add(grid);
  const area = new THREE.Group(); area.visible = false; scene.add(area);
  const markGeometry = new THREE.RingGeometry(0.16, 0.22, 20);
  const markMaterial = new THREE.MeshBasicMaterial({ color: '#648a78', side: THREE.DoubleSide });
  for (let x = -10; x <= 10; x += 5) for (let z = -10; z <= 10; z += 5) {
    const mark = new THREE.Mesh(markGeometry, markMaterial);
    mark.rotation.x = -Math.PI / 2; mark.position.set(x, 0, z); area.add(mark);
  }
  const handles = new THREE.Group();
  walkingFrame.add(handles);
  const targets = new THREE.Group();
  targets.visible = false;
  scene.add(targets);
  const targetGeometry = new THREE.SphereGeometry(0.095, 12, 8);
  const targetMaterial = new THREE.MeshBasicMaterial({ color: '#db6a3a', wireframe: true, depthTest: false });
  let ikMode = false;
  let standingMode = false;
  let walkingMode = false;
  let around = false;
  let aroundSpeed = 1;
  const held = new Set<string>();
  const savedCamera = new THREE.Vector3(), savedTarget = new THREE.Vector3(), followed = new THREE.Vector3();
  let walkingTime = 0;
  let walkingClock = performance.now();
  let walkingReportTime = 0;
  let walkingPaused = false;
  let walkingRate = 1;
  let showTimings = false, timingFrames = 0, timingElapsed = 0, timingCpu = 0, timingPose = 0, timingDraw = 0, timingWorst = 0;
  let inputAt = -1, inputDelay = -1;
  let walkingDirty = true;
  let gaitSettings = { ...defaultGaitSettings };
  let transferStrength = 0, transferLimit = 0.15;
  let bodyStrength = 0.5, tailStrength = 0.7;
  let leanStrength = 0.5, swayStrength = 0.7;
  let showFootTargets = true;
  const footTargets = new THREE.Group();
  walkingFrame.add(footTargets);
  const footTargetMaterial = new THREE.MeshBasicMaterial({ color: '#416eaa', wireframe: true, depthTest: false });
  const contacts = new THREE.Group();
  walkingFrame.add(contacts);
  const contactGeometry = new THREE.RingGeometry(0.11, 0.15, 24);
  const contactMaterial = new THREE.MeshBasicMaterial({ color: '#527b60', side: THREE.DoubleSide });
  const missedContactMaterial = new THREE.MeshBasicMaterial({ color: '#db6a3a', side: THREE.DoubleSide });
  let draggingGoal = -1;
  const handleGeometry = new THREE.SphereGeometry(0.066, 16, 12);
  const normalMaterial = new THREE.MeshBasicMaterial({ color: '#f7f6eb', depthTest: false });
  const selectedMaterial = new THREE.MeshBasicMaterial({ color: '#db6a3a', depthTest: false });
  const lineMaterial = new THREE.LineBasicMaterial({ color: '#f4f5eb', depthTest: false, transparent: true, opacity: 0.75 });
  const spineLine = new THREE.Line(new THREE.BufferGeometry(), lineMaterial);
  spineLine.frustumCulled = false;
  spineLine.renderOrder = 2;
  walkingFrame.add(spineLine);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const plane = new THREE.Plane();
  const normal = new THREE.Vector3();
  const point = new THREE.Vector3();
  const offset = new THREE.Vector3();
  let dragging: string | null = null;
  let spineIds = new Set<string>();
  let draggingSpine = false;
  let pointerId = -1;
  let shown = true;
  let frame = 0;
  let previewAngle: number | null = null;
  let limbAngle = 0;
  let sweep = false;
  let phase = 0;
  let lastTime = performance.now();

  function updateRay(event: PointerEvent) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  }
  function pointerDown(event: PointerEvent) {
    if (around) renderer.domElement.focus();
    if (event.button !== 0 || previewAngle !== null || standingMode || walkingMode) return;
    updateRay(event);
    if (ikMode) {
      const hit = raycaster.intersectObjects(targets.children, false)[0];
      if (!hit) return;
      event.stopImmediatePropagation(); event.preventDefault();
      draggingGoal = targets.children.indexOf(hit.object);
      pointerId = event.pointerId;
      camera.getWorldDirection(normal);
      plane.setFromNormalAndCoplanarPoint(normal, hit.object.position);
      raycaster.ray.intersectPlane(plane, point);
      offset.copy(hit.object.position).sub(point);
      orbit.enabled = false;
      renderer.domElement.setPointerCapture(pointerId);
      host.classList.add('dragging');
      return;
    }
    if (placementTool) {
      if (!skinReady || !rigView) return;
      const hits = placement.pick(raycaster, rigView.mesh, placementTool);
      if (!hits.length) return;
      event.stopImmediatePropagation(); event.preventDefault();
      placement.hide(); events.place(hits);
      return;
    }
    if (!shown) return;
    const hit = raycaster.intersectObjects(handles.children, false)[0];
    if (!hit) return;
    draggingSpine = spineIds.has(hit.object.name);
    // The body stays centred on the mirror plane; limbs still follow the camera plane.
    if (draggingSpine) plane.set(new THREE.Vector3(0, 0, 1), 0);
    else {
      camera.getWorldDirection(normal);
      plane.setFromNormalAndCoplanarPoint(normal, hit.object.position);
    }
    if (!raycaster.ray.intersectPlane(plane, point)) return;
    offset.copy(hit.object.position).sub(point);
    if (draggingSpine) offset.z = 0;
    event.stopImmediatePropagation();
    event.preventDefault();
    dragging = hit.object.name;
    pointerId = event.pointerId;
    events.select(dragging);
    events.begin();
    orbit.enabled = false;
    renderer.domElement.setPointerCapture(pointerId);
    host.classList.add('dragging');
  }
  function pointerMove(event: PointerEvent) {
    if (ikMode && draggingGoal >= 0 && event.pointerId === pointerId && rigView) {
      updateRay(event);
      if (raycaster.ray.intersectPlane(plane, point)) {
        point.add(offset);
        targets.children[draggingGoal].position.copy(point);
        rigView.goals[draggingGoal * 3] = point.x;
        rigView.goals[draggingGoal * 3 + 1] = point.y;
        rigView.goals[draggingGoal * 3 + 2] = point.z;
      }
      return;
    }
    if (placementTool && previewAngle === null) {
      updateRay(event);
      const hits = skinReady && rigView ? placement.pick(raycaster, rigView.mesh, placementTool) : [];
      placement.show(hits, placementTool); events.placementHint(hits.length);
      return;
    }
    if (!dragging || event.pointerId !== pointerId) return;
    updateRay(event);
    if (raycaster.ray.intersectPlane(plane, point)) {
      point.add(offset);
      if (draggingSpine) point.z = 0;
      events.move(dragging, [point.x, point.y, point.z]);
    }
  }
  function pointerLeave() { placement.hide(); events.placementHint(0); }
  function pointerEnd(event: PointerEvent) {
    if (draggingGoal >= 0 && event.pointerId === pointerId) {
      draggingGoal = -1; orbit.enabled = true;
      if (renderer.domElement.hasPointerCapture(pointerId)) renderer.domElement.releasePointerCapture(pointerId);
      host.classList.remove('dragging');
      return;
    }
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = null;
    orbit.enabled = true;
    if (renderer.domElement.hasPointerCapture(pointerId)) renderer.domElement.releasePointerCapture(pointerId);
    host.classList.remove('dragging');
    events.end();
  }
  renderer.domElement.addEventListener('pointerdown', pointerDown, true);
  renderer.domElement.addEventListener('pointermove', pointerMove);
  renderer.domElement.addEventListener('pointerup', pointerEnd);
  renderer.domElement.addEventListener('pointercancel', pointerEnd);
  renderer.domElement.addEventListener('lostpointercapture', pointerEnd);
  renderer.domElement.addEventListener('pointerleave', pointerLeave);
  function advanceWalkingClock(now: number) {
    if (walkingMode && !walkingPaused && !document.hidden) walkingTime += Math.max(0, now - walkingClock) / 1000 * walkingRate;
    walkingClock = now;
  }
  function drive(forward: number, left: number) {
    if (!around || !walkingMode || walkingPaused) return;
    advanceWalkingClock(performance.now());
    rigView?.driveWalk(walkingTime, forward, left, aroundSpeed); walkingDirty = true; walkingReportTime = 0;
  }
  function releaseDrive() {
    held.clear();
    advanceWalkingClock(performance.now());
    if (around) { rigView?.driveWalk(walkingTime, 0, 0); walkingDirty = true; walkingReportTime = 0; }
  }
  function keyboardDrive(event: KeyboardEvent) {
    const key = event.key.toLowerCase();
    if (!around || !['w', 'a', 's', 'd'].includes(key) || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (held.has(key)) return;
    inputAt = performance.now();
    held.add(key); drive(Number(held.has('w')) - Number(held.has('s')), Number(held.has('a')) - Number(held.has('d')));
  }
  function keyboardRelease(event: KeyboardEvent) {
    if (!held.delete(event.key.toLowerCase())) return;
    inputAt = performance.now();
    drive(Number(held.has('w')) - Number(held.has('s')), Number(held.has('a')) - Number(held.has('d')));
  }
  function visibilityDrive() {
    if (document.hidden) releaseDrive();
    lastTime = performance.now();
    walkingClock = lastTime;
    timingFrames = timingElapsed = timingCpu = timingPose = timingDraw = timingWorst = 0;
    gpuTime = gpuSamples = 0;
  }
  renderer.domElement.addEventListener('keydown', keyboardDrive);
  renderer.domElement.addEventListener('blur', releaseDrive);
  window.addEventListener('keyup', keyboardRelease);
  window.addEventListener('blur', releaseDrive);
  document.addEventListener('visibilitychange', visibilityDrive);
  const resize = new ResizeObserver(() => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  resize.observe(host);
  function draw(time = performance.now()) {
    const frameStart = performance.now(), interval = Math.max(0, time - lastTime);
    let poseCost = 0;
    const delta = Math.max(0, (time - lastTime) / 1000);
    lastTime = time;
    // Poses sample an analytic timeline, so a slow visible frame can skip ahead
    // without simulating missing frames or silently dropping movement time.
    advanceWalkingClock(frameStart);
    if (rigView && (previewAngle !== null || ikMode || standingMode || walkingMode)) {
      if (walkingMode) {
        const poseStart = performance.now();
        const walk = !walkingPaused || walkingDirty ? rigView.walk(walkingTime) : null;
        poseCost = performance.now() - poseStart;
        if (walk) {
          walkingDirty = false;
          balanceView.update(walk.stance.balance);
          const yaw = walk.gait.yaw, c = Math.cos(yaw), s = Math.sin(yaw), pivot = walk.gait.pivot;
          walkingFrame.rotation.y = yaw;
          walkingFrame.position.set(pivot[0] - c * pivot[0] - s * pivot[2], 0, pivot[2] + s * pivot[0] - c * pivot[2]);
          if (around) {
            const x = walk.gait.rootTravel[0], z = walk.gait.rootTravel[2];
            walkingFrame.position.x += x; walkingFrame.position.z += z;
            camera.position.x += x - followed.x; camera.position.z += z - followed.z;
            orbit.target.x += x - followed.x; orbit.target.z += z - followed.z;
            followed.set(x, 0, z);
            grid.position.x = 0; grid.position.z = 0;
          } else {
            // Treadmill preview follows translation; fixed-area mode moves the creature itself.
            grid.position.x = -walk.gait.rootTravel[0] % 1;
            grid.position.z = -walk.gait.rootTravel[2] % 1;
          }
          for (let foot = 0; foot < contacts.children.length; foot++) {
            const marker = contacts.children[foot] as THREE.Mesh;
            marker.visible = !!walk.gait.planted[foot];
            marker.position.set(walk.soles[foot * 3] + walk.gait.offsets[foot * 3], grid.position.y + 0.003, walk.soles[foot * 3 + 2] + walk.gait.offsets[foot * 3 + 2]);
            const error = Math.hypot(marker.position.x - walk.actual[foot * 3], walk.stance.gaps[foot], marker.position.z - walk.actual[foot * 3 + 2]);
            marker.material = error <= 0.01 ? contactMaterial : missedContactMaterial;
            footTargets.children[foot].position.set(marker.position.x, grid.position.y + walk.gait.offsets[foot * 3 + 1], marker.position.z);
          }
          if (time >= walkingReportTime) {
            walkingReportTime = time + 100;
            events.walkingHint(walk.grounded, walk.planted, walk.maximumError, walk.stance.unsupported, walkingTime, walk.gait, walk.stance.balance, Math.hypot(walk.transfer.offset[0], walk.transfer.offset[2]));
          }
        }
      }
      else if (ikMode) rigView.solve();
      else if (!standingMode) {
        if (sweep) phase = (phase + delta / 4) % 1;
        const amount = sweep ? Math.sin(phase * Math.PI * 2) : 1;
        rigView.bend(previewAngle! * amount, limbAngle * amount);
      }
      const attribute = spineLine.geometry.getAttribute('position');
      if (attribute && attribute.count <= rigView.positions.length / 3) {
        for (let index = 0; index < attribute.array.length; index++) attribute.array[index] = rigView.positions[index];
        attribute.needsUpdate = true;
        if (handles.children.length * 3 === rigView.positions.length) {
          for (let index = 0; index < handles.children.length; index++) handles.children[index].position.fromArray(rigView.positions, index * 3);
        }
      }
    }
    orbit.update();
    if (gpuQuery && gpuPending && gl.getQueryParameter(gpuQuery, gl.QUERY_RESULT_AVAILABLE)) {
      if (!gl.getParameter(gpuTimer!.GPU_DISJOINT_EXT)) { gpuTime += gl.getQueryParameter(gpuQuery, gl.QUERY_RESULT) / 1e6; gpuSamples++; }
      gpuPending = false;
    }
    const measuredQuery = showTimings && !gpuPending ? gpuQuery : null;
    if (measuredQuery) gl.beginQuery(gpuTimer!.TIME_ELAPSED_EXT, measuredQuery);
    const drawStart = performance.now();
    renderer.render(scene, camera);
    const finished = performance.now();
    if (measuredQuery) { gl.endQuery(gpuTimer!.TIME_ELAPSED_EXT); gpuPending = true; }
    if (inputAt >= 0) { inputDelay = finished - inputAt; inputAt = -1; }
    if (showTimings && !document.hidden) {
      timingFrames++; timingElapsed += interval; timingCpu += finished - frameStart;
      timingPose += poseCost; timingDraw += finished - drawStart; timingWorst = Math.max(timingWorst, interval);
      if (timingElapsed >= 1000) {
        events.performanceHint(timingFrames * 1000 / timingElapsed, timingCpu / timingFrames, timingPose / timingFrames, timingDraw / timingFrames, gpuSamples ? gpuTime / gpuSamples : -1, timingWorst, inputDelay);
        timingFrames = timingElapsed = timingCpu = timingPose = timingDraw = timingWorst = 0;
        gpuTime = gpuSamples = 0;
      }
    }
    frame = requestAnimationFrame(draw);
  }
  draw();

  function setCreature(creature: Creature, selectedId: string) {
    spineIds = new Set(creature.spine.map(vertebra => vertebra.id));
    material.color.set(creature.skinColor);
    const sources = resolveStructure(creature).sources;
    if (handles.children.length !== sources.length) {
      handles.clear();
      for (const vertebra of sources) {
        const handle = new THREE.Mesh(handleGeometry, normalMaterial);
        handle.name = vertebra.id;
        handle.renderOrder = 3;
        handles.add(handle);
      }
    }
    sources.forEach((vertebra, index) => {
      const handle = handles.children[index] as THREE.Mesh;
      handle.name = vertebra.id;
      handle.position.fromArray(vertebra.position);
      handle.material = !ikMode && !standingMode && !walkingMode && vertebra.id === selectedId ? selectedMaterial : normalMaterial;
      handle.scale.setScalar(!ikMode && !standingMode && !walkingMode && vertebra.id === selectedId ? 1.4 : 1);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(creature.spine.flatMap(vertebra => vertebra.position), 3));
    spineLine.geometry.dispose();
    spineLine.geometry = geometry;
  }

  let standingStrength = 0, standingMaximumShift = 0.25;
  function stand(value: boolean, strength = standingStrength, maximumShift = standingMaximumShift) {
    standingStrength = strength; standingMaximumShift = maximumShift;
    standingMode = value; contacts.visible = value;
    balanceView.show(value || walkingMode);
    if (!rigView) return;
    if (!value) return;
    const stance = rigView.stand(grid.position.y, strength, maximumShift);
    balanceView.update(stance.balance);
    contacts.clear();
    stance.contacts.forEach((_, index) => {
      const marker = new THREE.Mesh(contactGeometry, Math.abs(stance.gaps[index]) <= 0.01 ? contactMaterial : missedContactMaterial);
      marker.rotation.x = -Math.PI / 2;
      marker.position.fromArray(stance.contactPositions, index * 3); marker.position.y += 0.003;
      contacts.add(marker);
    });
    return { total: stance.contacts.length + stance.unsupported, grounded: stance.grounded, error: stance.maximumError, balance: stance.balance, correctionShift: stance.correctionShift, correctionBefore: stance.correctionBefore, anchorError: stance.anchorError };
  }

  function walk(value: boolean) {
    held.clear();
    if (!value && around) endAround();
    walkingMode = value; walkingTime = 0; walkingReportTime = 0; walkingClock = performance.now();
    balanceView.show(value || standingMode);
    walkingDirty = true;
    footTargets.visible = value && showFootTargets;
    grid.position.x = 0; grid.position.z = 0;
    walkingFrame.rotation.y = 0; walkingFrame.position.set(0, 0, 0);
    if (!value) { contacts.visible = standingMode; return; }
    if (!rigView) return;
    const walking = rigView.startWalk(grid.position.y, around ? walkAroundTempo : 1);
    if (around) rigView.driveWalk(0, 0, 0);
    rigView.tuneWalk({ ...gaitSettings, period: gaitSettings.period / (around ? walkAroundTempo : 1) });
    rigView.transferWalk(transferStrength, transferLimit);
    rigView.bodyWalk(bodyStrength);
    rigView.tailWalk(tailStrength);
    rigView.reactionWalk(leanStrength, swayStrength);
    footTargets.clear();
    contacts.clear(); contacts.visible = true;
    for (const _ of walking.stance.contacts) {
      const marker = new THREE.Mesh(contactGeometry, contactMaterial);
      marker.rotation.x = -Math.PI / 2; contacts.add(marker);
      const target = new THREE.Mesh(targetGeometry, footTargetMaterial);
      target.scale.setScalar(0.65); target.renderOrder = 4; footTargets.add(target);
    }
  }

  function endAround() {
    around = false; area.visible = false;
    camera.position.copy(savedCamera); orbit.target.copy(savedTarget); followed.set(0, 0, 0);
    renderer.domElement.tabIndex = -1;
    renderer.domElement.setAttribute('aria-label', 'Creature viewport. Drag a vertebra to shape the spine. Drag empty space to orbit.');
    orbit.update();
  }

  return {
    setCreature,
    stand,
    walk,
    showPerformance(value: boolean) {
      showTimings = value;
      timingFrames = timingElapsed = timingCpu = timingPose = timingDraw = timingWorst = 0;
      if (gpuQuery) gl.deleteQuery(gpuQuery);
      gpuQuery = value && gpuTimer ? gl.createQuery() : null; gpuPending = false; gpuTime = gpuSamples = 0;
    },
    walkAround(value: boolean) {
      if (value === around) return;
      if (value) {
        savedCamera.copy(camera.position); savedTarget.copy(orbit.target); followed.set(0, 0, 0);
        around = true; area.visible = true; area.position.y = grid.position.y + 0.004;
        renderer.domElement.tabIndex = 0;
        renderer.domElement.setAttribute('aria-label', 'Walk around area. W and S move, A and D strafe.');
      } else endAround();
      walk(walkingMode);
      if (value) renderer.domElement.focus();
    },
    driveWalk(forward: number, left: number) { held.clear(); drive(forward, left); renderer.domElement.focus(); },
    toggleWalk() { advanceWalkingClock(performance.now()); rigView?.toggleWalk(walkingTime); walkingDirty = true; walkingReportTime = 0; },
    reactionWalk(lean: number, sway: number) { leanStrength = lean; swayStrength = sway; rigView?.reactionWalk(lean, sway); walkingDirty = true; walkingReportTime = 0; },
    tailWalk(strength: number) { tailStrength = strength; rigView?.tailWalk(strength); walkingDirty = true; walkingReportTime = 0; },
    bodyWalk(strength: number) { bodyStrength = strength; rigView?.bodyWalk(strength); walkingDirty = true; walkingReportTime = 0; },
    transferWalk(strength: number, maximumShift: number) {
      transferStrength = strength; transferLimit = maximumShift;
      rigView?.transferWalk(strength, maximumShift); walkingDirty = true; walkingReportTime = 0;
    },
    speedWalk(factor: number) {
      advanceWalkingClock(performance.now());
      if (around) aroundSpeed = factor;
      else rigView?.speedWalk(walkingTime, factor);
      walkingDirty = true; walkingReportTime = 0;
    },
    turnWalk(radiansPerSecond: number) { advanceWalkingClock(performance.now()); rigView?.turnWalk(walkingTime, radiansPerSecond); walkingDirty = true; walkingReportTime = 0; },
    tuneWalk(settings: GaitSettings) {
      gaitSettings = { ...settings, period: settings.period * (around ? walkAroundTempo : 1) }; rigView?.tuneWalk(settings);
      walkingDirty = true; walkingReportTime = 0;
    },
    walkPlayback(paused: boolean, rate: number) {
      advanceWalkingClock(performance.now());
      if (paused) releaseDrive();
      walkingPaused = paused; walkingRate = rate;
      walkingDirty = true; walkingReportTime = 0;
    },
    seekWalk(seconds: number) {
      walkingTime = Math.max(0, seconds); walkingClock = performance.now(); walkingDirty = true; walkingReportTime = 0;
    },
    stepWalk() { walkingTime += 1 / 60; walkingClock = performance.now(); walkingDirty = true; walkingReportTime = 0; },
    showFootTargets(value: boolean) { showFootTargets = value; footTargets.visible = walkingMode && value; },
    showBalance(value: boolean) { balanceView.enabled(value); },
    placement(tool: PlacementTool | null) {
      placementTool = tool; placement.hide();
      placement.active(!!tool);
      renderer.domElement.style.cursor = tool ? 'crosshair' : '';
    },
    skinPending() { skinReady = false; placement.hide(); },
    setSkin(skin: Skin, rig: Rig) {
      if (rigView) { walkingFrame.remove(rigView.mesh, rigView.overlay); rigView.dispose(); }
      rigView = createRigView(skin, rig, material);
      balanceView.resize(skin.positions.length / 3);
      targets.clear();
      rigView.targets.forEach((target, index) => {
        const handle = new THREE.Mesh(targetGeometry, targetMaterial);
        handle.name = target.boneId;
        handle.position.fromArray(rigView!.goals, index * 3);
        handle.renderOrder = 4;
        targets.add(handle);
      });
      placement.setSkin(skin);
      skinReady = true;
      walkingFrame.add(rigView.mesh, rigView.overlay);
      rigView.overlay.visible = shown;
      grid.position.y = (rigView.mesh.geometry.boundingBox?.min.y ?? -1) - 0.08;
      area.position.y = grid.position.y + 0.004;
      stand(standingMode);
      walk(walkingMode);
      return rigView.maximumDiscarded;
    },
    preview(angle: number | null, animate: boolean, limbRadians = 0) {
      previewAngle = angle;
      sweep = animate;
      limbAngle = limbRadians;
      if (angle === null) { phase = 0; rigView?.bend(0); }
    },
    ik(value: boolean) {
      if (ikMode === value) return;
      ikMode = value; targets.visible = value;
      rigView?.resetGoals();
      if (rigView) targets.children.forEach((target, index) => target.position.fromArray(rigView!.goals, index * 3));
      if (!value) rigView?.bend(0);
    },
    wireframe(value: boolean) { material.wireframe = value; },
    showSpine(value: boolean) { shown = value; handles.visible = value; spineLine.visible = value; if (rigView) rigView.overlay.visible = value; },
    frameCreature() {
      if (!rigView) return;
      rigView.mesh.updateMatrixWorld(true);
      rigView.mesh.computeBoundingBox();
      const bounds = rigView.mesh.boundingBox!.clone().applyMatrix4(rigView.mesh.matrixWorld);
      if (bounds.isEmpty()) return;
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3()).length();
      const direction = camera.position.clone().sub(orbit.target).normalize();
      orbit.target.copy(center);
      camera.position.copy(center).addScaledVector(direction, Math.max(2, size * 1.7 / Math.min(camera.aspect, 1)));
      orbit.update();
    },
    dispose() {
      cancelAnimationFrame(frame);
      resize.disconnect();
      orbit.dispose();
      renderer.domElement.removeEventListener('pointerdown', pointerDown, true);
      renderer.domElement.removeEventListener('pointermove', pointerMove);
      renderer.domElement.removeEventListener('pointerup', pointerEnd);
      renderer.domElement.removeEventListener('pointercancel', pointerEnd);
      renderer.domElement.removeEventListener('lostpointercapture', pointerEnd);
      renderer.domElement.removeEventListener('pointerleave', pointerLeave);
      renderer.domElement.removeEventListener('keydown', keyboardDrive);
      renderer.domElement.removeEventListener('blur', releaseDrive);
      window.removeEventListener('keyup', keyboardRelease);
      window.removeEventListener('blur', releaseDrive);
      document.removeEventListener('visibilitychange', visibilityDrive);
      markGeometry.dispose(); markMaterial.dispose();
      placement.dispose();
      balanceView.dispose();
      rigView?.dispose();
      spineLine.geometry.dispose();
      handleGeometry.dispose();
      targetGeometry.dispose(); targetMaterial.dispose();
      footTargetMaterial.dispose();
      contactGeometry.dispose(); contactMaterial.dispose(); missedContactMaterial.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      material.dispose(); normalMaterial.dispose(); selectedMaterial.dispose(); lineMaterial.dispose();
      if (gpuQuery) gl.deleteQuery(gpuQuery);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
