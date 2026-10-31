import * as THREE from "three";
import { DEMO_BASES, DEMO_COMBAT_SITES, demoSupplyRoute } from "./quest-demo";
import type { QuestBattle, Side } from "./quest-combat";

/** Rear-base trunks branch into three 3D supply lanes for the main fights and depth skirmishes. Flow stops with simulation time. */
export class QuestSupplyView {
  private root = new THREE.Group();
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private direction = new THREE.Vector3();
  private rotation = new THREE.Quaternion();
  private scale = new THREE.Vector3(1, 1, 1);
  private routes = DEMO_COMBAT_SITES.flatMap(site => ([0, 1] as Side[]).map(side => {
    const points = demoSupplyRoute(site.id, side).map(p => new THREE.Vector3().copy(p));
    return { points, side, lengths: points.slice(1).map((p, i) => p.distanceTo(points[i]!)) };
  }));
  private flow = [0x82d5ff, 0xff7e8d].map(color => {
    const mesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.04, 0.16, 3),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false }), DEMO_COMBAT_SITES.length * 3);
    mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); return mesh;
  });
  constructor(world: THREE.Group) {
    this.root.name = "demo-supply-lines"; this.root.visible = false; world.add(this.root);
    for (const route of this.routes) {
      // The common trunk is drawn once per side, so its opacity stays subtle.
      const points = route.points.slice(route === this.routes[0] || route === this.routes[1] ? 0 : 1);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineDashedMaterial({ color: route.side === 0 ? 0x82d5ff : 0xff7e8d, transparent: true, opacity: 0.24, depthWrite: false, dashSize: 0.13, gapSize: 0.1 }));
      line.computeLineDistances(); this.root.add(line);
    }
    this.root.add(...this.flow);
    DEMO_BASES.forEach((base, side) => {
      const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 80;
      const context = canvas.getContext("2d")!;
      context.fillStyle = side === 0 ? "#82d5ff" : "#ff7e8d";
      context.font = "bold 46px monospace"; context.textAlign = "center";
      context.fillText(side === 0 ? "FRIENDLY BASE" : "HOSTILE BASE", 256, 56);
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      const label = new THREE.Mesh(new THREE.PlaneGeometry(2, 0.32),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      label.position.copy(base); label.position.y += 1.1; this.root.add(label);
    });
  }
  update(battle: QuestBattle, enabled: boolean): void {
    this.root.visible = enabled; if (!enabled) return;
    const counts = [0, 0];
    for (const route of this.routes) for (let marker = 0; marker < 3; marker++) {
      const total = route.lengths.reduce((a, b) => a + b, 0);
      let distance = ((battle.tick / 240 + marker / 3) % 1) * total, segment = 0;
      while (segment < route.lengths.length - 1 && distance > route.lengths[segment]!) distance -= route.lengths[segment++]!;
      this.position.copy(route.points[segment]!).lerp(route.points[segment + 1]!, distance / route.lengths[segment]!);
      this.direction.copy(route.points[segment + 1]!).sub(route.points[segment]!).normalize();
      this.rotation.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, this.direction);
      this.matrix.compose(this.position, this.rotation, this.scale);
      const index = counts[route.side]!; counts[route.side] = index + 1;
      this.flow[route.side]!.setMatrixAt(index, this.matrix);
    }
    this.flow.forEach(mesh => { mesh.instanceMatrix.needsUpdate = true; });
  }
}
