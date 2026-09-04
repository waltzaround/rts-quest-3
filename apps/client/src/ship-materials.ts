import * as THREE from "three";

/** Surface detail shares the hull draw call. No textures, decals as separate
 * meshes, lights, or per-ship uniforms. Derivatives fade subpixel panel lines.
 */
export function createShipSurfaceMaterial(layer: "hull" | "armor"): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: layer === "hull" ? 0xb2c0ca : 0x718391,
    emissive: 0x08121b, emissiveIntensity: 0.24,
    metalness: 0.38, roughness: 0.59, flatShading: true,
  });
  material.onBeforeCompile = shader => {
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
        varying vec3 vShipNormal;`)
      .replace("#include <color_fragment>", `#include <color_fragment>
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
        diffuseColor.rgb *= (0.9 + panel * 0.14) * (1.0 - seam * 0.4);
        // Narrow ivory service stripe and segmented registry marks: paint,
        // not illumination. Their fixed world size makes capitals feel large.
        float stripe = (1.0 - smoothstep(0.13, 0.13 + fwidth(surface.x), abs(surface.x - 1.65))) * deck;
        stripe *= step(0.16, fract(surface.y / 18.0));
        float hatch = step(0.72, cell.x) * step(cell.x, 0.88) * step(0.69, cell.y) * step(cell.y, 0.83);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.67, 0.66), stripe * 0.68 * detail);
        diffuseColor.rgb *= 1.0 - hatch * detail * 0.24;
        // A dark structural belt under the shoulder, with no extra geometry.
        float belt = (1.0 - deck) * (1.0 - smoothstep(0.22, 0.38, abs(vShipSurface.y - 1.0)));
        diffuseColor.rgb *= 1.0 - belt * 0.45;
      `);
  };
  material.customProgramCacheKey = () => "ship-surface-v1";
  return material;
}
