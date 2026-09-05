import * as THREE from "three";
import { SHIPS, type FactionId, type ShipClass } from "@space-rts/game-core";
import { getShipHullGeometries } from "./ship-hulls";

export interface DamageSite {
  position: THREE.Vector3;
  orientation: THREE.Quaternion;
}

const sitesByClass = new Map<string, readonly DamageSite[]>();

/** Sample the actual armor once per class. Breaches remain attached when the
 * ship turns or banks, with no raycasts or allocations in the frame loop.
 */
export function getShipDamageSites(shipClass: ShipClass, faction: FactionId = "industrial"): readonly DamageSite[] {
  const key = `${faction}:${shipClass}`;
  const cached = sitesByClass.get(key);
  if (cached) return cached;
  const hull = getShipHullGeometries(shipClass, faction);
  const surfaces = [new THREE.Mesh(hull.hull), new THREE.Mesh(hull.armor)];
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const up = new THREE.Vector3(0, 1, 0);
  const radius = SHIPS[shipClass].radius;
  const sites: DamageSite[] = [];
  for (const [x, z] of [[-0.2, 0.4], [0.24, -0.36], [0.12, 0.04], [-0.25, -0.2], [0.22, 0.5], [-0.12, -0.5], [-0.42, 0.2], [0.42, -0.2], [-0.4, -0.4], [0.4, 0.4], [0, 0.25], [0, -0.3]]) {
    ray.set(new THREE.Vector3(x! * radius, radius * 2, z! * radius), down);
    const hit = ray.intersectObjects(surfaces, false)[0];
    if (!hit?.face || hit.face.normal.y < 0.6) continue;
    sites.push({
      position: hit.point.clone().addScaledVector(hit.face.normal, 0.06),
      orientation: new THREE.Quaternion().setFromUnitVectors(up, hit.face.normal),
    });
    if (sites.length === 6) break;
  }
  for (const surface of surfaces) (surface.material as THREE.Material).dispose();
  sitesByClass.set(key, sites);
  return sites;
}

export function createBreachGeometry(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
}

/** One pooled quad combines soot, exposed metal and animated molten cracks.
 * Instance color encodes severity and flicker phase; it is not a team tint.
 */
export function createBreachMaterial(time: { value: number }): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  material.onBeforeCompile = shader => {
    shader.uniforms.breachTime = time;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        varying vec2 vBreachUv;
        varying vec3 vBreachData;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vBreachUv = position.xz;
        #ifdef USE_INSTANCING_COLOR
          vBreachData = instanceColor;
        #else
          vBreachData = vec3(0.0);
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float breachTime;
        varying vec2 vBreachUv;
        varying vec3 vBreachData;`)
      .replace("#include <color_fragment>", `
        vec2 p = vBreachUv;
        float severity = vBreachData.r;
        float phase = vBreachData.g * 31.0;
        float ragged = sin(p.x * 23.0 + sin(p.y * 17.0)) * sin(p.y * 19.0 + phase);
        float r = length(p * vec2(1.0, 1.2)) + ragged * 0.085;
        float soot = 1.0 - smoothstep(0.48, 0.98, r);
        float rim = (1.0 - smoothstep(0.025, 0.095, abs(r - 0.37))) * 0.28;
        float crack = 1.0 - smoothstep(0.02, 0.065, abs(p.x + sin(p.y * 13.0 + phase) * 0.09));
        crack = max(crack, (1.0 - smoothstep(0.014, 0.045, abs(p.y + p.x * 0.7))) * 0.7);
        crack *= 1.0 - smoothstep(0.24, 0.55, r);
        float pulse = 0.75 + sin(breachTime * 8.0 + phase) * sin(breachTime * 13.0 + phase) * 0.25;
        float heat = crack * smoothstep(0.22, 0.95, severity) * pulse;
        vec3 surface = vec3(0.012, 0.014, 0.018) + vec3(0.23, 0.16, 0.1) * rim;
        surface += mix(vec3(0.9, 0.095, 0.009), vec3(2.0, 0.58, 0.08), heat) * heat;
        diffuseColor = vec4(surface, soot * 0.94);
      `);
  };
  material.customProgramCacheKey = () => "ship-breach-v1";
  return material;
}
