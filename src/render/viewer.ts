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

export function createViewer(host: HTMLElement, events: {
  select: (id: string) => void;
  move: (id: string, position: Position) => void;
  begin: () => void;
  end: () => void;
  place: (hits: AttachmentPoint[]) => void;
  placementHint: (count: number) => void;
}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor('#eaece5', 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.setAttribute('aria-label', 'Creature viewport. Drag a vertebra to shape the spine. Drag empty space to orbit.');
  host.prepend(renderer.domElement);
  const scene = new THREE.Scene();
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
  const handles = new THREE.Group();
  scene.add(handles);
  const targets = new THREE.Group();
  targets.visible = false;
  scene.add(targets);
  const targetGeometry = new THREE.SphereGeometry(0.095, 12, 8);
  const targetMaterial = new THREE.MeshBasicMaterial({ color: '#db6a3a', wireframe: true, depthTest: false });
  let ikMode = false;
  let draggingGoal = -1;
  const handleGeometry = new THREE.SphereGeometry(0.066, 16, 12);
  const normalMaterial = new THREE.MeshBasicMaterial({ color: '#f7f6eb', depthTest: false });
  const selectedMaterial = new THREE.MeshBasicMaterial({ color: '#db6a3a', depthTest: false });
  const lineMaterial = new THREE.LineBasicMaterial({ color: '#f4f5eb', depthTest: false, transparent: true, opacity: 0.75 });
  const spineLine = new THREE.Line(new THREE.BufferGeometry(), lineMaterial);
  spineLine.frustumCulled = false;
  spineLine.renderOrder = 2;
  scene.add(spineLine);
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
    if (event.button !== 0 || previewAngle !== null) return;
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
  const resize = new ResizeObserver(() => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  resize.observe(host);
  function draw(time = performance.now()) {
    const delta = Math.min(0.1, Math.max(0, (time - lastTime) / 1000));
    lastTime = time;
    if (rigView && (previewAngle !== null || ikMode)) {
      if (ikMode) rigView.solve();
      else {
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
    renderer.render(scene, camera);
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
      handle.material = !ikMode && vertebra.id === selectedId ? selectedMaterial : normalMaterial;
      handle.scale.setScalar(!ikMode && vertebra.id === selectedId ? 1.4 : 1);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(creature.spine.flatMap(vertebra => vertebra.position), 3));
    spineLine.geometry.dispose();
    spineLine.geometry = geometry;
  }

  return {
    setCreature,
    placement(tool: PlacementTool | null) {
      placementTool = tool; placement.hide();
      placement.active(!!tool);
      renderer.domElement.style.cursor = tool ? 'crosshair' : '';
    },
    skinPending() { skinReady = false; placement.hide(); },
    setSkin(skin: Skin, rig: Rig) {
      if (rigView) { scene.remove(rigView.mesh, rigView.overlay); rigView.dispose(); }
      rigView = createRigView(skin, rig, material);
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
      scene.add(rigView.mesh, rigView.overlay);
      rigView.overlay.visible = shown;
      grid.position.y = (rigView.mesh.geometry.boundingBox?.min.y ?? -1) - 0.08;
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
      const bounds = rigView.mesh.boundingBox!;
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
      placement.dispose();
      rigView?.dispose();
      spineLine.geometry.dispose();
      handleGeometry.dispose();
      targetGeometry.dispose(); targetMaterial.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      material.dispose(); normalMaterial.dispose(); selectedMaterial.dispose(); lineMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
