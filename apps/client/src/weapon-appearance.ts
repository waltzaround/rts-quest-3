import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { type FactionId, type ProjectileState, type WeaponTypeId } from "@space-rts/game-core";

export interface WeaponStyle {
  color: number;
  rgb: readonly [number, number, number];
  height: number;
  trailLength: number;
  width: number;
  headScale: readonly [number, number, number];
  brightness: number;
}

function style(color: number, height: number, trailLength: number, width: number,
  headScale: WeaponStyle["headScale"], brightness = 1): WeaponStyle {
  const rgb = new THREE.Color(color);
  return { color, rgb: [rgb.r, rgb.g, rgb.b], height, trailLength, width, headScale, brightness };
}

const INDUSTRIAL: Readonly<Record<WeaponTypeId, WeaponStyle>> = {
  autocannon: style(0xf0bd69, 4.2, 4.2, 0.09, [0.12, 0.12, 0.5], 0.34),
  torpedo: style(0xff795f, 10, 8, 0.28, [0.46, 0.46, 1.35], 0.9),
  plasma: style(0x58ddff, 7.2, 14, 0.45, [0.55, 0.55, 0.9], 0.85),
  heavyRail: style(0xfff0c2, 10.2, 40, 0.42, [0.38, 0.38, 3.2], 1.08),
  pointDefense: style(0x8dffb0, 6.8, 5.5, 0.07, [0.12, 0.12, 0.65], 0.38),
  flakCannon: style(0xb7ff9a, 7.1, 6.5, 0.1, [0.16, 0.16, 0.8], 0.48),
  beam: style(0xa8f7ff, 8.5, 54, 0.55, [0.4, 0.4, 3.2]),
  lightArtillery: style(0xffdf9b, 9.5, 44, 0.46, [0.44, 0.44, 3.4], 1.05),
  siegeArtillery: style(0xffd37a, 11, 58, 0.58, [0.56, 0.56, 4.2], 1.2),
  strategicArtillery: style(0xffbd6b, 14, 78, 0.76, [0.72, 0.72, 5.8], 1.4),
};

// Keep the weapon's original altitude and relative weight; faction styling
// never changes its trajectory, collision radius, rate of fire or damage.
function variant(type: WeaponTypeId, color: number, width: number, length: number,
  headScale: WeaponStyle["headScale"], brightness = 0.85): WeaponStyle {
  return style(color, INDUSTRIAL[type].height, length, width, headScale, brightness);
}
const BROOD: Readonly<Record<WeaponTypeId, WeaponStyle>> = {
  autocannon: variant("autocannon", 0xc3ed83, 0.14, 3.4, [0.16, 0.16, 0.55], 0.46),
  pointDefense: variant("pointDefense", 0xe1f8a3, 0.11, 4, [0.15, 0.15, 0.7], 0.42),
  flakCannon: variant("flakCannon", 0xc0de69, 0.2, 5.5, [0.28, 0.25, 0.7], 0.55),
  plasma: variant("plasma", 0x9fdf60, 0.7, 12, [0.78, 0.68, 1.3]),
  torpedo: variant("torpedo", 0xe1ab70, 0.58, 11, [0.75, 0.67, 1.9]),
  heavyRail: variant("heavyRail", 0xeff2ad, 0.5, 32, [0.37, 0.34, 3.9], 1),
  beam: variant("beam", 0xc6f57b, 0.7, 54, [0.4, 0.4, 3.2]),
  lightArtillery: variant("lightArtillery", 0xf0bd80, 0.64, 32, [0.65, 0.58, 2.6]),
  siegeArtillery: variant("siegeArtillery", 0xf6a982, 0.78, 42, [0.85, 0.7, 3.2], 1),
  strategicArtillery: variant("strategicArtillery", 0xff9185, 0.96, 54, [1, 0.85, 4.3], 1.15),
};
const CONCORD: Readonly<Record<WeaponTypeId, WeaponStyle>> = {
  autocannon: variant("autocannon", 0x9debe2, 0.11, 5.6, [0.13, 0.13, 0.85], 0.46),
  pointDefense: variant("pointDefense", 0xc5fff3, 0.09, 6.5, [0.13, 0.13, 0.9], 0.4),
  flakCannon: variant("flakCannon", 0x9dc7ff, 0.17, 7, [0.27, 0.2, 0.85], 0.5),
  plasma: variant("plasma", 0x82f2de, 0.4, 17, [0.57, 0.48, 1.6]),
  torpedo: variant("torpedo", 0xa3b7ff, 0.34, 16, [0.65, 0.5, 2.3]),
  heavyRail: variant("heavyRail", 0xd3fff6, 0.32, 45, [0.35, 0.28, 4], 1),
  beam: variant("beam", 0xa0f8ec, 0.5, 54, [0.4, 0.4, 3.2]),
  lightArtillery: variant("lightArtillery", 0xacc7ff, 0.4, 46, [0.48, 0.36, 3.7]),
  siegeArtillery: variant("siegeArtillery", 0xbcb4ff, 0.51, 60, [0.63, 0.45, 4.8], 1),
  strategicArtillery: variant("strategicArtillery", 0xd4b9ff, 0.65, 78, [0.82, 0.6, 6], 1.15),
};
const STYLES = { industrial: INDUSTRIAL, brood: BROOD, concord: CONCORD };
export function getWeaponStyle(type: WeaponTypeId, faction: FactionId = "industrial"): WeaponStyle {
  return STYLES[faction][type];
}
export function weaponFactionIndex(faction: FactionId): number {
  return faction === "brood" ? 1 : faction === "concord" ? 2 : 0;
}

export function createProjectileGeometry(type: WeaponTypeId, faction: FactionId): THREE.BufferGeometry {
  const rapid = type === "autocannon" || type === "pointDefense" || type === "flakCannon";
  if (faction === "brood") {
    if (rapid || type === "heavyRail") {
      // Bone needles, with a bulbous root and a narrow piercing tip.
      return new THREE.ConeGeometry(0.8, 2.4, rapid ? 4 : 5).rotateX(Math.PI / 2);
    }
    const sac = new THREE.IcosahedronGeometry(1, 1);
    const p = sac.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i), swell = 0.83 + 0.14 * Math.sin(z * 7) - z * 0.12;
      p.setXYZ(i, p.getX(i) * swell, p.getY(i) * swell, z * 1.45);
    }
    sac.computeVertexNormals();
    return sac;
  }
  if (faction === "concord") {
    const crystal = new THREE.OctahedronGeometry(1).scale(1, 0.65, 1.5);
    if (rapid || type === "heavyRail") return crystal;
    // A central lance and two detached crystal vanes, merged into one head.
    const left = new THREE.OctahedronGeometry(1).scale(0.24, 0.2, 0.72).translate(-0.8, 0, -0.42);
    const right = left.clone().translate(1.6, 0, 0);
    const merged = mergeGeometries([crystal, left, right]);
    crystal.dispose(); left.dispose(); right.dispose();
    return merged;
  }
  if (type === "torpedo") return new THREE.CapsuleGeometry(0.72, 2.6, 3, 8).rotateX(Math.PI / 2);
  if (type === "plasma") return new THREE.ConeGeometry(0.95, 4.8, 6).rotateX(Math.PI / 2);
  if (type === "heavyRail") return new THREE.OctahedronGeometry(1);
  return new THREE.BoxGeometry(0.7, 0.7, 2.1);
}

/** Both factions keep the original two six-vertex streak batches. The organic
 * membrane and crystal interruptions are cut into those quads in the shader,
 * avoiding particles, trail histories, textures and extra draw calls. */
export function createWeaponTrailMaterial(opacity: number): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        attribute vec2 weaponEffect;
        varying vec2 vWeaponEffect;
        varying vec2 vTrailUv;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vWeaponEffect = weaponEffect;
        vTrailUv = uv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec2 vWeaponEffect;
        varying vec2 vTrailUv;`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float t = vTrailUv.x;
        float side = vTrailUv.y;
        if (vWeaponEffect.x > 0.5 && vWeaponEffect.x < 1.5) {
          float vein = sin(t * 18.0 - vWeaponEffect.y) * 0.22 * (1.0 - t);
          float membrane = 0.28 + t * 0.48 + sin(t * 29.0 + vWeaponEffect.y) * 0.1;
          float d = abs(side - vein);
          diffuseColor.a *= 1.0 - smoothstep(membrane * 0.55, membrane, d);
          diffuseColor.rgb *= 0.65 + 0.5 * (1.0 - smoothstep(0.02, 0.18, d));
        } else if (vWeaponEffect.x > 1.5) {
          float facet = 0.22 + 0.7 * (1.0 - abs(fract(t * 4.0) * 2.0 - 1.0));
          float gap = smoothstep(0.06, 0.16, fract(t * 4.0));
          diffuseColor.a *= gap * (1.0 - smoothstep(facet - 0.1, facet, abs(side)));
        }`);
  };
  material.customProgramCacheKey = () => "faction-weapon-trail-v1";
  return material;
}

/** Only observed ownership and public team information are used. Keep each
 * shot's identity after its source dies or leaves visibility. A mixed-faction
 * team with an unseen source gets a neutral tracer until its source is known. */
export class ProjectileAppearanceRegistry {
  private owners = new Map<number, FactionId>();
  private current = new Map<number, FactionId>();
  private previous = new Map<number, FactionId>();

  sync(projectiles: readonly ProjectileState[],
    ships: readonly { id: number; faction?: FactionId }[],
    structures: readonly { id: number; ownerPlayerId: string }[],
    players: readonly { id: string; teamId: number; faction?: FactionId }[]): void {
    const playersById = new Map(players.map(p => [p.id, p.faction ?? "industrial"] as const));
    const teams = new Map<number, FactionId | null>();
    for (const player of players) {
      const faction = player.faction ?? "industrial";
      teams.set(player.teamId, teams.has(player.teamId) && teams.get(player.teamId) !== faction ? null : faction);
    }
    const owners = new Map<number, FactionId>();
    for (const ship of ships) owners.set(ship.id, ship.faction ?? "industrial");
    for (const structure of structures) owners.set(structure.id, playersById.get(structure.ownerPlayerId) ?? "industrial");
    this.previous = this.current;
    this.current = new Map();
    for (const projectile of projectiles) {
      const knownOwner = owners.get(projectile.ownerShipId) ?? this.owners.get(projectile.ownerShipId);
      const faction = knownOwner ?? this.previous.get(projectile.id) ?? teams.get(projectile.ownerTeamId);
      if (faction) this.current.set(projectile.id, faction);
    }
    this.owners = owners;
  }

  remember(projectileId: number, faction: FactionId): void { this.current.set(projectileId, faction); }
  get(projectileId: number): FactionId { return this.current.get(projectileId) ?? this.previous.get(projectileId) ?? "industrial"; }
  clear(): void { this.owners.clear(); this.current.clear(); this.previous.clear(); }
}
