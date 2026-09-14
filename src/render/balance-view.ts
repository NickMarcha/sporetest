import * as THREE from 'three';
import type { Balance } from '../anim/balance.ts';

export function createBalanceView(scene: THREE.Object3D) {
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  const supported = new THREE.LineBasicMaterial({ color: '#527b60', depthTest: false });
  const outside = new THREE.LineBasicMaterial({ color: '#db6a3a', depthTest: false });
  const centreMaterial = new THREE.MeshBasicMaterial({ color: '#8062a1', depthTest: false });
  const projectionMaterial = new THREE.MeshBasicMaterial({ color: '#527b60', side: THREE.DoubleSide, depthTest: false });
  const centreGeometry = new THREE.SphereGeometry(0.06, 12, 8);
  const projectionGeometry = new THREE.RingGeometry(0.075, 0.105, 24);
  const centre = new THREE.Mesh(centreGeometry, centreMaterial);
  const projection = new THREE.Mesh(projectionGeometry, projectionMaterial); projection.rotation.x = -Math.PI / 2;
  let hullGeometry = new THREE.BufferGeometry();
  const hull = new THREE.Line(hullGeometry, supported);
  const dropGeometry = new THREE.BufferGeometry();
  const dropPositions = new Float32Array(12);
  dropGeometry.setAttribute('position', new THREE.BufferAttribute(dropPositions, 3));
  const drop = new THREE.LineSegments(dropGeometry, supported);
  for (const item of [centre, projection, hull, drop]) { item.renderOrder = 5; item.frustumCulled = false; group.add(item); }
  let enabled = true, active = false;
  function show(value: boolean) { active = value; group.visible = active && enabled; }
  return {
    show,
    enabled(value: boolean) { enabled = value; show(active); },
    resize(vertices: number) {
      hullGeometry.dispose(); hullGeometry = new THREE.BufferGeometry(); hull.geometry = hullGeometry;
      hullGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((vertices + 1) * 3), 3));
    },
    update(balance: Balance) {
      centre.visible = projection.visible = drop.visible = balance.available;
      centre.position.fromArray(balance.centre);
      projection.position.set(balance.centre[0], balance.nearest[1] + 0.007, balance.centre[2]);
      projectionMaterial.color.set(balance.inside ? '#527b60' : '#db6a3a');
      drop.material = balance.inside ? supported : outside;
      dropPositions.set(balance.centre, 0);
      dropPositions[3] = balance.centre[0]; dropPositions[4] = projection.position.y; dropPositions[5] = balance.centre[2];
      dropPositions[6] = dropPositions[3]; dropPositions[7] = dropPositions[4]; dropPositions[8] = dropPositions[5];
      dropPositions[9] = balance.nearest[0]; dropPositions[10] = projection.position.y; dropPositions[11] = balance.nearest[2];
      dropGeometry.setDrawRange(0, balance.hullCount > 0 && !balance.inside ? 4 : 2);
      dropGeometry.getAttribute('position').needsUpdate = true;
      const attribute = hullGeometry.getAttribute('position');
      hull.visible = balance.hullCount > 1;
      for (let i = 0; i <= balance.hullCount && balance.hullCount > 0; i++) {
        const source = balance.hull[i % balance.hullCount] * 3;
        attribute.array[i * 3] = balance.points[source]; attribute.array[i * 3 + 1] = projection.position.y; attribute.array[i * 3 + 2] = balance.points[source + 2];
      }
      attribute.needsUpdate = true;
      hullGeometry.setDrawRange(0, balance.hullCount > 0 ? balance.hullCount + 1 : 0);
    },
    dispose() {
      scene.remove(group); hullGeometry.dispose(); dropGeometry.dispose(); centreGeometry.dispose(); projectionGeometry.dispose();
      supported.dispose(); outside.dispose(); centreMaterial.dispose(); projectionMaterial.dispose();
    },
  };
}
