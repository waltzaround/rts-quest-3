import * as THREE from "three";
import { MarchingCubes } from "three/addons/objects/MarchingCubes.js";
import type { CombatEntity, QuestBattle } from "./quest-combat";
import { type Point3 } from "./quest-simulation";

const RESOLUTION = 32;
type Region = { center: Point3; extent: Point3 };
function influenceParameters(entity: CombatEntity) {
  const radius = entity.encounterId !== undefined && entity.structureType ? 3.2 : entity.structureType ? 1.85 : 1.45 + Math.min(0.4, entity.radius * 2);
  const base = entity.structureType ? 2.2 : entity.shipClass === "fighter" || entity.shipClass === "bomber" ? 0.45 : 0.85;
  return { radius, strength: base * Math.sqrt((entity.health + entity.shields) / (entity.maxHealth + entity.maxShields)) };
}

/** Compact 3D influence: altitude matters, distant space stays unclaimed. */
export function territoryInfluence(entity: CombatEntity, point: Point3): number {
  if (entity.health <= 0 || entity.construction > 0) return 0;
  const { radius, strength } = influenceParameters(entity);
  const dx = point.x - entity.position.x, dy = point.y - entity.position.y, dz = point.z - entity.position.z;
  const falloff = Math.max(0, 1 - (dx * dx + dy * dy + dz * dz) / (radius * radius));
  return falloff * falloff * falloff * strength;
}

/** One shared field across all sectors, with two bounded meshes refreshed twice a simulation second. */
export class QuestTerritoryView {
  private entries: Array<{ region: Region; surfaces: [MarchingCubes, MarchingCubes] }> = [];
  private battle: QuestBattle | null = null;
  private demo = false;
  private selectionKey = "";
  private revealUntil = 0;
  private lastTick = -Infinity;
  private cameraPosition = new THREE.Vector3();
  private point = new THREE.Vector3();
  private densities = [new Float32Array(RESOLUTION ** 3), new Float32Array(RESOLUTION ** 3)];

  constructor(private world: THREE.Group) {}

  private material(side: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { tint: { value: new THREE.Color(side === 0 ? 0x82d5ff : 0xff7e8d) }, fade: { value: 1 },
        regionCenter: { value: new THREE.Vector3() }, regionExtent: { value: new THREE.Vector3() }, battleScale: { value: 1 }, time: { value: 0 }, cameraLocal: { value: new THREE.Vector3() },
        handA: { value: new THREE.Vector3(1e6, 1e6, 1e6) }, handB: { value: new THREE.Vector3(1e6, 1e6, 1e6) },
        handRadius: { value: 0.3 }, focus: { value: new THREE.Vector3() }, reveal: { value: 0 } },
      vertexShader: `uniform vec3 regionCenter; uniform vec3 regionExtent; attribute float pressure; varying float contested; varying vec3 localPoint; varying vec3 worldPoint; varying vec3 viewNormal; varying vec3 viewPosition;
        void main() {
          localPoint = position * regionExtent + regionCenter; worldPoint = (modelMatrix * vec4(position, 1.0)).xyz;
          contested = pressure;
          vec4 p = modelViewMatrix * vec4(position, 1.0);
          viewNormal = normalize(normalMatrix * normal); viewPosition = -p.xyz;
          gl_Position = projectionMatrix * p;
        }`,
      fragmentShader: `uniform vec3 tint; uniform float fade; uniform float time;
        uniform vec3 cameraLocal; uniform vec3 handA; uniform vec3 handB; uniform float handRadius;
        uniform vec3 focus; uniform float reveal; uniform float battleScale;
        varying float contested; varying vec3 localPoint; varying vec3 worldPoint; varying vec3 viewNormal; varying vec3 viewPosition;
        void main() {
          float facing = abs(dot(normalize(viewNormal), normalize(viewPosition)));
          float rim = 1.0 - smoothstep(0.025, 0.13, facing);
          float dash = smoothstep(0.25, 0.38, fract(dot(localPoint, vec3(1.7, 2.3, 1.3))));
          float proximity = smoothstep(0.3, 1.5, distance(worldPoint, cameraLocal));
          float hands = smoothstep(handRadius * 0.4, handRadius, min(distance(worldPoint, handA), distance(worldPoint, handB)));
          float highlight = reveal * (1.0 - smoothstep(1.0, 4.0, distance(worldPoint, focus) / battleScale));
          float pulse = 0.7 + 0.3 * sin(time * 1.8);
          vec3 color = mix(tint, vec3(1.0, 0.68, 0.28), contested * pulse);
          float alpha = rim * dash * proximity * hands * (0.16 * fade + 0.12 * highlight);
          if (alpha < 0.003) discard;
          gl_FragColor = vec4(color, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
  }

  private reset(battle: QuestBattle, demo: boolean): void {
    for (const entry of this.entries) for (const surface of entry.surfaces) {
      this.world.remove(surface); surface.geometry.dispose(); (surface.material as THREE.Material).dispose();
    }
    const regions: Region[] = demo ? [{ center: { x: 0, y: (battle.volume.minY + battle.volume.maxY) / 2, z: 0 },
        extent: { x: battle.volume.x + 1.7, y: (battle.volume.maxY - battle.volume.minY) / 2 + 1.7, z: battle.volume.z + 1.7 } }] : [];
    this.entries = regions.map(region => {
      const surfaces = [0, 1].map(side => {
        const surface = new MarchingCubes(RESOLUTION, this.material(side), false, false, 10000);
        surface.geometry.setAttribute("pressure", new THREE.BufferAttribute(new Float32Array(surface.geometry.getAttribute("position").count), 1));
        surface.isolation = 0.28; surface.position.copy(region.center);
        surface.scale.copy(region.extent); surface.renderOrder = -1; surface.frustumCulled = false;
        surface.name = `territory-${demo ? "front" : "skirmish"}-${side}`;
        this.world.add(surface); return surface;
      }) as [MarchingCubes, MarchingCubes];
      return { region, surfaces };
    });
    this.battle = battle; this.demo = demo; this.lastTick = -Infinity;
  }

  update(battle: QuestBattle, demo: boolean, camera: THREE.Camera, hands: readonly THREE.Vector3[] = [], selected: ReadonlySet<number> = new Set()): void {
    if (this.battle !== battle || this.demo !== demo) this.reset(battle, demo);
    if (!demo) return;
    camera.getWorldPosition(this.cameraPosition); this.world.worldToLocal(this.cameraPosition);
    const now = performance.now() / 1000;
    const selectionKey = [...selected].join(",");
    if (selectionKey !== this.selectionKey) { this.selectionKey = selectionKey; this.revealUntil = now + 2; }
    const focus = battle.entities.find(e => selected.has(e.id) && e.health > 0);
    const refresh = battle.tick - this.lastTick >= 10;
    for (const { region, surfaces } of this.entries) {
      const distance = this.cameraPosition.distanceTo(this.point.copy(region.center));
      const fade = THREE.MathUtils.smoothstep(distance, 7, 25);
      for (const surface of surfaces) {
        const u = (surface.material as THREE.ShaderMaterial).uniforms;
        u.regionCenter!.value.copy(region.center); u.regionExtent!.value.copy(region.extent); u.battleScale!.value = this.world.getWorldScale(this.point).x;
        u.fade!.value = fade; u.time!.value = battle.tick / 20;
        // Shader positions and contact points share physical world coordinates.
        u.cameraLocal!.value.copy(this.cameraPosition); this.world.localToWorld(u.cameraLocal!.value);
        u.handA!.value.copy(hands[0] ?? this.point.set(1e6, 1e6, 1e6));
        u.handB!.value.copy(hands[1] ?? this.point.set(1e6, 1e6, 1e6));
        u.reveal!.value = focus ? Math.max(0, Math.min(1, this.revealUntil - now)) : 0;
        if (focus) { u.focus!.value.copy(focus.position); this.world.localToWorld(u.focus!.value); }
      }
      if (!refresh) continue;
      this.densities.forEach(d => d.fill(0));
      const entities = battle.entities.filter(e => e.health > 0 && e.construction === 0);
      for (const entity of entities) {
        const { radius, strength } = influenceParameters(entity), density = this.densities[entity.side]!;
        const bounds = (axis: "x" | "y" | "z", sign: number) => THREE.MathUtils.clamp(
          Math[sign < 0 ? "floor" : "ceil"](((entity.position[axis] + sign * radius - region.center[axis]) / region.extent[axis] + 1) * RESOLUTION / 2), 1, RESOLUTION - 2);
        const minX = bounds("x", -1), maxX = bounds("x", 1), minY = bounds("y", -1), maxY = bounds("y", 1), minZ = bounds("z", -1), maxZ = bounds("z", 1);
        for (let z = minZ; z <= maxZ; z++) for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
          const dx = region.center.x + (x * 2 / RESOLUTION - 1) * region.extent.x - entity.position.x;
          const dy = region.center.y + (y * 2 / RESOLUTION - 1) * region.extent.y - entity.position.y;
          const dz = region.center.z + (z * 2 / RESOLUTION - 1) * region.extent.z - entity.position.z;
          const falloff = Math.max(0, 1 - (dx * dx + dy * dy + dz * dz) / (radius * radius));
          const index = x + y * RESOLUTION + z * RESOLUTION * RESOLUTION;
          density[index] = density[index]! + falloff * falloff * falloff * strength;
        }
      }
      surfaces.forEach((surface, side) => {
        surface.reset();
        for (let i = 0; i < surface.field.length; i++) {
          // Opposing pressure carves a shared curved front out of each territory volume.
          surface.field[i] = Math.max(0, this.densities[side]![i]! - this.densities[1 - side]![i]! * 0.85);
        }
        surface.update();
        const positions = surface.geometry.getAttribute("position"), pressure = surface.geometry.getAttribute("pressure") as THREE.BufferAttribute;
        for (let v = 0; v < surface.geometry.drawRange.count; v++) {
          const cell = (n: number) => THREE.MathUtils.clamp(Math.round((n + 1) * RESOLUTION / 2), 0, RESOLUTION - 1);
          const i = cell(positions.getX(v)) + cell(positions.getY(v)) * RESOLUTION + cell(positions.getZ(v)) * RESOLUTION * RESOLUTION;
          const own = this.densities[side]![i]!, enemy = this.densities[1 - side]![i]!;
          pressure.setX(v, THREE.MathUtils.smoothstep(enemy / Math.max(own, 0.001), 0.2, 0.8));
        }
        pressure.needsUpdate = true;
      });
    }
    if (refresh) this.lastTick = battle.tick;
  }
}
