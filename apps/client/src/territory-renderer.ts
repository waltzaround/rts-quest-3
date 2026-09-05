import * as THREE from "three";
import type { TerritoryFieldState } from "@space-rts/game-core";

/** Shared geometry with reusable meshes; territory stays on the tactical plane below fog. */
export class TerritoryRenderer {
  private readonly geometry = new THREE.CircleGeometry(1, 64);
  private readonly ring = new THREE.RingGeometry(0.986, 1, 64);
  private readonly materials = {
    creep: new THREE.MeshBasicMaterial({ color: 0x9851b9, transparent: true, opacity: 0.11, side: THREE.DoubleSide, depthWrite: false }),
    pylon: new THREE.MeshBasicMaterial({ color: 0x49dace, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }),
  };
  private readonly edges = {
    creep: new THREE.MeshBasicMaterial({ color: 0xc17fe9, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false }),
    pylon: new THREE.MeshBasicMaterial({ color: 0x75efdf, transparent: true, opacity: 0.52, side: THREE.DoubleSide, depthWrite: false }),
  };
  private readonly pool: THREE.Group[] = [];

  constructor(private readonly root: THREE.Group) {}

  update(fields: readonly TerritoryFieldState[]): void {
    while (this.pool.length < fields.length) {
      const group = new THREE.Group();
      group.add(new THREE.Mesh(this.geometry, this.materials.creep), new THREE.Mesh(this.ring, this.edges.creep));
      group.rotation.x = -Math.PI / 2;
      this.root.add(group);
      this.pool.push(group);
    }
    for (let index = 0; index < this.pool.length; index += 1) {
      const group = this.pool[index]!;
      const field = fields[index];
      group.visible = field !== undefined;
      if (!field) continue;
      group.position.set(field.x, 0.4, field.z);
      group.scale.setScalar(field.radius);
      (group.children[0] as THREE.Mesh).material = this.materials[field.kind];
      (group.children[1] as THREE.Mesh).material = this.edges[field.kind];
    }
  }
}
