import * as THREE from 'three';
import { createPose, writeBendPose } from '../anim/pose.ts';
import { createIK, solveIK } from '../anim/ik.ts';
import { createStanding, writeStandingPose } from '../anim/standing.ts';
import { createWalking, writeWalkingPose } from '../anim/walking.ts';
import type { Walking } from '../anim/walking.ts';
import { packWeights } from '../rig/weights.ts';
import type { Rig } from '../rig/rig.ts';
import type { Skin } from '../mesh/mesh.ts';

export function createRigView(skin: Skin, rig: Rig, material: THREE.MeshStandardMaterial) {
  const packed = packWeights(rig.weights, 4);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(skin.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(skin.normals, 3));
  // Three's stock skinning shader takes vec4 indices; Uint32 attributes use an integer
  // vertex pointer and do not match that shader input. Convert only at this boundary.
  geometry.setAttribute('skinIndex', new THREE.Float32BufferAttribute(packed.indices, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(packed.values, 4));
  geometry.setIndex(new THREE.BufferAttribute(skin.triangles, 1));
  geometry.computeBoundingBox();
  const mesh = new THREE.SkinnedMesh(geometry, material);
  // This viewport contains one creature. Avoid stale rest-pose culling or O(vertices)
  // bounding-box work on every pose; explicit framing computes the posed bounds on demand.
  mesh.frustumCulled = false;
  const bones = rig.bones.map(bone => {
    const rendered = new THREE.Bone();
    rendered.name = bone.id;
    rendered.matrixAutoUpdate = false;
    rendered.matrix.fromArray(bone.restLocal);
    return rendered;
  });
  rig.bones.forEach((bone, index) => {
    if (bone.parent < 0) mesh.add(bones[index]);
    else bones[bone.parent].add(bones[index]);
  });
  const skeleton = new THREE.Skeleton(bones, rig.bones.map(bone => new THREE.Matrix4().fromArray(bone.inverseBind)));
  mesh.bind(skeleton, new THREE.Matrix4());
  const pose = createPose(rig.bones);
  const ik = createIK(rig.bones);
  const targets = ik.targets;
  const stance = createStanding(skin, rig);
  let walking: Walking | null = null;
  const positions = new Float32Array(bones.length * 3);
  const edges = rig.bones.flatMap((bone, index) => bone.kind !== 'limb' || bone.parent < 0 ? [] : [bone.parent, index]);
  const linePositions = new Float32Array(edges.length * 3);
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
  const lineMaterial = new THREE.LineBasicMaterial({ color: '#f4f5eb', depthTest: false, transparent: true, opacity: 0.65 });
  const overlay = new THREE.LineSegments(lineGeometry, lineMaterial);
  overlay.frustumCulled = false; overlay.renderOrder = 2;
  function bend(radians: number, limbRadians = 0) {
    writeBendPose(rig.bones, radians, pose, limbRadians);
    update();
  }
  function update() {
    for (let index = 0; index < bones.length; index++) {
      bones[index].matrix.fromArray(pose.local[index]);
      bones[index].matrixWorldNeedsUpdate = true;
      positions[index * 3] = pose.creature[index][12];
      positions[index * 3 + 1] = pose.creature[index][13];
      positions[index * 3 + 2] = pose.creature[index][14];
    }
    for (let index = 0; index < edges.length; index++) {
      const source = edges[index] * 3;
      linePositions[index * 3] = positions[source];
      linePositions[index * 3 + 1] = positions[source + 1];
      linePositions[index * 3 + 2] = positions[source + 2];
    }
    lineGeometry.getAttribute('position').needsUpdate = true;
  }
  bend(0);
  return {
    mesh, overlay, positions, bend,
    targets, goals: ik.goals,
    stance,
    startWalk(floorY: number) { walking = createWalking(skin, rig, floorY, pose); return walking; },
    walk(seconds: number) {
      if (!walking) return null;
      writeWalkingPose(skin, rig, walking, seconds, pose); update(); return walking;
    },
    stand(floorY: number) { writeStandingPose(skin, rig, stance, floorY, pose); update(); return stance; },
    solve() {
      solveIK(rig.bones, ik, pose);
      update();
    },
    resetGoals() {
      targets.forEach((target, index) => {
        const bone = rig.bones.find(bone => bone.id === target.boneId)!;
        for (let axis = 0; axis < 3; axis++) ik.goals[index * 3 + axis] = bone.restCreature[12 + axis];
      });
    },
    maximumDiscarded: packed.maximumDiscarded,
    dispose() { geometry.dispose(); skeleton.dispose(); lineGeometry.dispose(); lineMaterial.dispose(); },
  };
}
