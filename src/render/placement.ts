import * as THREE from 'three';
import { attachmentPositions, attachmentRadii } from '../creature/attachment.ts';
import type { AttachmentPoint, LimbPreset } from '../creature/attachment.ts';
import type { Skin } from '../mesh/mesh.ts';

export type PlacementTool = { kind: LimbPreset; mirror: boolean };
export const CENTER_SNAP = 0.14; // Metres from the authoring plane Z = 0.

export function createPlacementPreview(scene: THREE.Scene) {
  const group = new THREE.Group(); scene.add(group); group.visible = false;
  const material = new THREE.MeshBasicMaterial({ color: '#de793f', transparent: true, opacity: 0.38, depthTest: false, depthWrite: false });
  const sphere = new THREE.SphereGeometry(1, 12, 8);
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 12);
  const balls = Array.from({ length: 6 }, () => new THREE.Mesh(sphere, material));
  const links = Array.from({ length: 4 }, () => new THREE.Mesh(cylinder, material));
  group.add(...balls, ...links);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), direction = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const reflected = new THREE.Raycaster();
  const centerMaterial = new THREE.LineDashedMaterial({ color: '#b57346', dashSize: 0.045, gapSize: 0.035, transparent: true, opacity: 0.6, depthTest: false, depthWrite: false });
  const centerLine = new THREE.LineSegments(new THREE.BufferGeometry(), centerMaterial);
  centerLine.visible = false; centerLine.renderOrder = 4; scene.add(centerLine);
  function setSkin(skin: Skin) {
    const positions: number[] = [];
    for (let index = 0; index < skin.triangles.length; index += 3) {
      const crossings: number[] = [];
      for (let edge = 0; edge < 3; edge++) {
        const a = skin.triangles[index + edge] * 3, b = skin.triangles[index + (edge + 1) % 3] * 3;
        const az = skin.positions[a + 2], bz = skin.positions[b + 2];
        if ((az < 0) === (bz < 0)) continue;
        const t = az / (az - bz);
        crossings.push(skin.positions[a] + t * (skin.positions[b] - skin.positions[a]), skin.positions[a + 1] + t * (skin.positions[b + 1] - skin.positions[a + 1]), 0);
      }
      if (crossings.length === 6) positions.push(...crossings);
    }
    centerLine.geometry.dispose();
    centerLine.geometry = new THREE.BufferGeometry();
    centerLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    centerLine.computeLineDistances();
  }
  function pick(raycaster: THREE.Raycaster, mesh: THREE.SkinnedMesh, tool: PlacementTool) {
    mesh.updateMatrixWorld(true);
    const hit = raycaster.intersectObject(mesh, false)[0];
    if (!hit || !hit.face) return [];
    const result: AttachmentPoint[] = [];
    const append = (hit: THREE.Intersection) => {
      const normal = hit.normal?.clone() ?? hit.face!.normal.clone();
      normal.transformDirection(mesh.matrixWorld);
      result.push({ position: [hit.point.x, hit.point.y, hit.point.z], normal: [normal.x, normal.y, normal.z] });
    };
    if (Math.abs(hit.point.z) <= CENTER_SNAP) {
      reflected.ray.copy(raycaster.ray);
      reflected.ray.origin.z = 0; reflected.ray.direction.z = 0;
      if (reflected.ray.direction.lengthSq() > 1e-8) {
        reflected.ray.direction.normalize();
        const center = reflected.intersectObject(mesh, false)[0];
        if (center && center.point.distanceTo(hit.point) < CENTER_SNAP * 2) {
          append(center); result[0].position[2] = 0; result[0].normal[2] = 0;
          return result;
        }
      }
    }
    append(hit);
    if (tool.mirror) {
      reflected.ray.copy(raycaster.ray);
      reflected.ray.origin.z *= -1; reflected.ray.direction.z *= -1;
      const other = reflected.intersectObject(mesh, false)[0];
      // A pair needs skin on both sides. Never attach its second limb in empty space.
      if (!other || other.point.z * hit.point.z >= 0) return [];
      const mirroredPoint = hit.point.clone(); mirroredPoint.z *= -1;
      // The linked pair is an exact reflection. Its root must still reach the opposite skin.
      if (other.point.distanceTo(mirroredPoint) > 0.25) return [];
      result.push({ position: [mirroredPoint.x, mirroredPoint.y, mirroredPoint.z], normal: [result[0].normal[0], result[0].normal[1], -result[0].normal[2]] });
    }
    return result;
  }
  function show(hits: AttachmentPoint[], tool: PlacementTool) {
    group.visible = hits.length > 0;
    balls.forEach(ball => { ball.visible = false; }); links.forEach(link => { link.visible = false; });
    hits.forEach((hit, limb) => {
      const positions = attachmentPositions(hit, tool.kind);
      const radii = attachmentRadii(tool.kind);
      positions.forEach((position, index) => {
        const ball = balls[limb * 3 + index]; ball.visible = true; ball.position.fromArray(position); ball.scale.setScalar(radii[index]);
      });
      for (let index = 0; index < 2; index++) {
        a.fromArray(positions[index]); b.fromArray(positions[index + 1]); direction.subVectors(b, a);
        const link = links[limb * 2 + index]; link.visible = true;
        link.position.copy(a).add(b).multiplyScalar(0.5);
        const radius = (radii[index] + radii[index + 1]) / 2;
        link.scale.set(radius, direction.length(), radius);
        link.quaternion.setFromUnitVectors(up, direction.normalize());
      }
    });
  }
  return { pick, show, setSkin, active(value: boolean) { centerLine.visible = value; }, hide() { group.visible = false; }, dispose() { scene.remove(group, centerLine); centerLine.geometry.dispose(); centerMaterial.dispose(); sphere.dispose(); cylinder.dispose(); material.dispose(); } };
}
