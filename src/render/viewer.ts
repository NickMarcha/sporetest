import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Creature, Position } from '../creature/creature.ts';
import type { Skin } from '../mesh/mesh.ts';

export function createViewer(host: HTMLElement, events: {
  select: (id: string) => void;
  move: (id: string, position: Position) => void;
  begin: () => void;
  end: () => void;
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
  const skinMesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  scene.add(skinMesh);
  const grid = new THREE.GridHelper(30, 30, '#bac1b6', '#d1d6cb');
  grid.position.y = -1.05;
  grid.material.transparent = true;
  grid.material.opacity = 0.25;
  scene.add(grid);
  const handles = new THREE.Group();
  scene.add(handles);
  const handleGeometry = new THREE.SphereGeometry(0.066, 16, 12);
  const normalMaterial = new THREE.MeshBasicMaterial({ color: '#f7f6eb', depthTest: false });
  const selectedMaterial = new THREE.MeshBasicMaterial({ color: '#db6a3a', depthTest: false });
  const lineMaterial = new THREE.LineBasicMaterial({ color: '#f4f5eb', depthTest: false, transparent: true, opacity: 0.75 });
  const spineLine = new THREE.Line(new THREE.BufferGeometry(), lineMaterial);
  spineLine.renderOrder = 2;
  scene.add(spineLine);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const plane = new THREE.Plane();
  const normal = new THREE.Vector3();
  const point = new THREE.Vector3();
  const offset = new THREE.Vector3();
  let dragging: string | null = null;
  let pointerId = -1;
  let shown = true;
  let frame = 0;

  function updateRay(event: PointerEvent) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  }
  function pointerDown(event: PointerEvent) {
    if (event.button !== 0 || !shown) return;
    updateRay(event);
    const hit = raycaster.intersectObjects(handles.children, false)[0];
    if (!hit) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    dragging = hit.object.name;
    pointerId = event.pointerId;
    events.select(dragging);
    events.begin();
    orbit.enabled = false;
    camera.getWorldDirection(normal);
    plane.setFromNormalAndCoplanarPoint(normal, hit.object.position);
    raycaster.ray.intersectPlane(plane, point);
    offset.copy(hit.object.position).sub(point);
    renderer.domElement.setPointerCapture(pointerId);
    host.classList.add('dragging');
  }
  function pointerMove(event: PointerEvent) {
    if (!dragging || event.pointerId !== pointerId) return;
    updateRay(event);
    if (raycaster.ray.intersectPlane(plane, point)) {
      point.add(offset);
      events.move(dragging, [point.x, point.y, point.z]);
    }
  }
  function pointerEnd(event: PointerEvent) {
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
  const resize = new ResizeObserver(() => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  resize.observe(host);
  function draw() {
    orbit.update();
    renderer.render(scene, camera);
    frame = requestAnimationFrame(draw);
  }
  draw();

  function setCreature(creature: Creature, selectedId: string) {
    material.color.set(creature.skinColor);
    if (handles.children.length !== creature.spine.length) {
      handles.clear();
      for (const vertebra of creature.spine) {
        const handle = new THREE.Mesh(handleGeometry, normalMaterial);
        handle.name = vertebra.id;
        handle.renderOrder = 3;
        handles.add(handle);
      }
    }
    creature.spine.forEach((vertebra, index) => {
      const handle = handles.children[index] as THREE.Mesh;
      handle.name = vertebra.id;
      handle.position.fromArray(vertebra.position);
      handle.material = vertebra.id === selectedId ? selectedMaterial : normalMaterial;
      handle.scale.setScalar(vertebra.id === selectedId ? 1.4 : 1);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(creature.spine.flatMap(vertebra => vertebra.position), 3));
    spineLine.geometry.dispose();
    spineLine.geometry = geometry;
  }

  return {
    setCreature,
    setSkin(skin: Skin) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(skin.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(skin.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(skin.triangles, 1));
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      skinMesh.geometry.dispose();
      skinMesh.geometry = geometry;
      grid.position.y = (geometry.boundingBox?.min.y ?? -1) - 0.08;
    },
    wireframe(value: boolean) { material.wireframe = value; },
    showSpine(value: boolean) { shown = value; handles.visible = value; spineLine.visible = value; },
    frameCreature() {
      const bounds = new THREE.Box3().setFromObject(skinMesh);
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
      skinMesh.geometry.dispose();
      spineLine.geometry.dispose();
      handleGeometry.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      material.dispose(); normalMaterial.dispose(); selectedMaterial.dispose(); lineMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
