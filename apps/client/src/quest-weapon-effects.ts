import { weaponEffectStrength } from "./quest-effect-visibility";
import * as THREE from "three";
import type { WeaponTypeId } from "@space-rts/game-core";
import { createProjectileGeometry, getWeaponStyle } from "./weapon-appearance";
import { PROJECTILE_CAP, WORLD_SCALE, type Shot } from "./quest-combat";

/** Original weapon heads/palette, instanced on the actual 3D projectile paths. */
export class QuestWeaponEffects {
  private batches = new Map<WeaponTypeId, { mesh: THREE.InstancedMesh; count: number }>();
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private endpoint = new THREE.Vector3();
  private direction = new THREE.Vector3();
  private forward = new THREE.Vector3(0, 0, 1);
  private rotation = new THREE.Quaternion();
  private scale = new THREE.Vector3();
  private color = new THREE.Color();
  constructor(private world: THREE.Group) {}
  clear(): void { for (const batch of this.batches.values()) batch.mesh.count = batch.count = 0; }
  update(shots: readonly Shot[], alpha: number, camera?: THREE.Vector3, overview = false): void {
    this.clear();
    if (overview) return;
    for (let i = 0; i < Math.min(shots.length, PROJECTILE_CAP); i++) {
      const shot = shots[i]!;
      this.position.copy(shot.previous).lerp(this.endpoint.copy(shot.position), alpha);
      const strength = camera ? weaponEffectStrength(camera, this.position) : 1;
      if (strength <= 0) continue;
      const style = getWeaponStyle(shot.weapon);
      let batch = this.batches.get(shot.weapon);
      if (!batch) {
        const mesh = new THREE.InstancedMesh(createProjectileGeometry(shot.weapon, "industrial"), new THREE.MeshBasicMaterial({ color: style.color, toneMapped: false, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }), PROJECTILE_CAP);
        mesh.name = "weapon-heads"; mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.world.add(mesh);
        batch = { mesh, count: 0 }; this.batches.set(shot.weapon, batch);
      }
      this.direction.copy(shot.velocity).normalize(); this.rotation.setFromUnitVectors(this.forward, this.direction);
      this.scale.set(...style.headScale).multiplyScalar(WORLD_SCALE * 2);
      this.matrix.compose(this.position, this.rotation, this.scale); batch.mesh.setMatrixAt(batch.count, this.matrix);
      batch.mesh.setColorAt(batch.count++, this.color.setScalar(strength));
    }
    for (const batch of this.batches.values()) {
      batch.mesh.count = batch.count; batch.mesh.instanceMatrix.needsUpdate = true;
      if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
    }
  }
}
