import * as THREE from "three";
import type { FactionId } from "@space-rts/game-core";
import { SHIP_LIVERY_GLSL, type ShipLivery } from "./ship-livery";

export const FACTION_SURFACES = {
  industrial: { hull: 0x9ba9ac, armor: 0xc9d0cc, dark: 0x1b2b36, glow: 0xc6eaff },
  brood: { hull: 0x695469, armor: 0xbc8e87, dark: 0x37263f, glow: 0xc6f99d },
  concord: { hull: 0x849f9e, armor: 0xe5e6d9, dark: 0x284b52, glow: 0x89ffe5 },
} as const;

/** Surface detail shares the hull draw call. No textures, decals as separate
 * meshes, lights, or per-ship uniforms. Derivatives fade subpixel panel lines.
 */
export function createShipSurfaceMaterial(layer: "hull" | "armor", faction: FactionId = "industrial", livery?: ShipLivery): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: FACTION_SURFACES[faction][layer],
    emissive: 0x1b2529, emissiveIntensity: 0.18,
    metalness: faction === "brood" ? 0.06 : 0.28, roughness: faction === "brood" ? 0.79 : 0.62, flatShading: true,
  });
  if (faction !== "industrial") {
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vFactionSurface;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFactionSurface = position;");
      const pattern = faction === "brood"
        ? "sin(vFactionSurface.z * 2.1 + sin(vFactionSurface.x * 1.7) * 1.3)"
        : "sin((abs(vFactionSurface.x) + vFactionSurface.z * 0.7) * 2.4)";
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vFactionSurface;")
        .replace("#include <color_fragment>", `#include <color_fragment>\nfloat pattern = ${pattern};\nfloat fade = 1.0 - smoothstep(0.15, 0.8, length(fwidth(vFactionSurface)));\ndiffuseColor.rgb *= 1.0 - smoothstep(0.87, 0.99, pattern) * 0.09 * fade;`);
    };
    material.customProgramCacheKey = () => `faction-surface-${faction}-v1`;
    return material;
  }
  material.onBeforeCompile = shader => {
    if (livery) {
      shader.uniforms.shipLiveryOrigin = { value: livery.origin };
      shader.uniforms.shipLiverySize = { value: livery.size };
      shader.uniforms.shipLiveryTeam = { value: livery.teamColor };
    }
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        varying vec3 vShipSurface;
        varying vec3 vShipNormal;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vShipSurface = position;
        vShipNormal = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vShipSurface;
        varying vec3 vShipNormal;
        ${livery ? SHIP_LIVERY_GLSL : ""}`)
      .replace("#include <color_fragment>", `${livery ? `
        // Instance color is ownership paint only. Never multiply the neutral
        // chassis by it; the viewer supplies the same color via a uniform.
        vec3 ownerPaint = shipLiveryTeam;
        #if defined(USE_COLOR) || defined(USE_COLOR_ALPHA)
          ownerPaint = vColor.rgb;
        #endif
        float paintMask = shipLiveryMask(vShipSurface, normalize(vShipNormal));
        diffuseColor.rgb = mix(diffuseColor.rgb, ownerPaint * 0.55 + vec3(0.012), paintMask);
      ` : "#include <color_fragment>"}
        // Project decks and flanks separately so the armor belt has depth.
        float deck = step(0.65, abs(vShipNormal.y));
        vec2 surface = mix(vec2(vShipSurface.z, vShipSurface.y), vShipSurface.xz, deck);
        vec2 grid = surface / vec2(3.2, 5.6);
        grid.x += mod(floor(grid.y), 2.0) * 0.5;
        vec2 cell = fract(grid);
        vec2 edge = min(cell, 1.0 - cell);
        vec2 aa = max(fwidth(grid), vec2(0.001));
        vec2 lines = 1.0 - smoothstep(vec2(0.006), vec2(0.006) + aa, edge);
        float detail = 1.0 - smoothstep(0.07, 0.24, max(aa.x, aa.y));
        float seam = max(lines.x, lines.y) * detail;
        float panel = fract(sin(dot(floor(grid), vec2(12.9898, 78.233))) * 43758.5453);
        diffuseColor.rgb *= (0.96 + panel * 0.055) * (1.0 - seam * 0.13);
        // Narrow ivory service stripe and segmented registry marks: paint,
        // not illumination. Their fixed world size makes capitals feel large.
        float stripe = (1.0 - smoothstep(0.13, 0.13 + fwidth(surface.x), abs(surface.x - 1.65))) * deck;
        stripe *= step(0.16, fract(surface.y / 18.0));
        float hatch = step(0.72, cell.x) * step(cell.x, 0.88) * step(0.69, cell.y) * step(cell.y, 0.83);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.67, 0.66), stripe * 0.68 * detail);
        diffuseColor.rgb *= 1.0 - hatch * detail * 0.24;
        // A subtle panel joint under the shoulder, with no extra geometry.
        float belt = (1.0 - deck) * (1.0 - smoothstep(0.22, 0.38, abs(vShipSurface.y - 1.0)));
        diffuseColor.rgb *= 1.0 - belt * 0.1;
      `);
  };
  material.customProgramCacheKey = () => livery ? "ship-surface-livery-v1" : "ship-surface-v2";
  return material;
}
