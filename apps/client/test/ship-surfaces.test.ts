import * as THREE from "three";
import { ALL_SHIP_CLASSES } from "@space-rts/game-core";
import { expect, it } from "vitest";
import { getShipHullGeometries } from "../src/ship-hulls";
import { createShipLivery } from "../src/ship-livery";
import { createShipSurfaceMaterial, FACTION_SURFACES } from "../src/ship-materials";

it("keeps neutral industrial base materials and shares masked paint coordinates across surface layers", () => {
  for (const shipClass of ALL_SHIP_CLASSES) {
    const geometry = getShipHullGeometries(shipClass);
    const livery = createShipLivery([geometry.hull, geometry.armor], 0xff5a78);
    expect(livery.size.x).toBeGreaterThan(0);
    expect(livery.size.z).toBeGreaterThan(0);
    for (const layer of ["hull", "armor"] as const) {
      const material = createShipSurfaceMaterial(layer, "industrial", livery);
      expect(material.color.getHex()).toBe(FACTION_SURFACES.industrial[layer]);
      const shader = { ...THREE.ShaderLib.standard, uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms) };
      material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      expect(shader.uniforms.shipLiveryOrigin!.value).toBe(livery.origin);
      expect(shader.uniforms.shipLiverySize!.value).toBe(livery.size);
      expect(shader.uniforms.shipLiveryTeam!.value.getHex()).toBe(0xff5a78);
      // Reintroducing Three's vertex-color multiply here would tint the
      // entire ship again, even with a correctly painted mask on top.
      expect(shader.fragmentShader).not.toContain("#include <color_fragment>");
      expect(shader.fragmentShader).toContain("ownerPaint = vColor.rgb");
      expect(shader.fragmentShader).toContain("float paintMask = shipLiveryMask");
      expect(material.customProgramCacheKey()).not.toBe(createShipSurfaceMaterial(layer).customProgramCacheKey());
      material.dispose();
    }
  }
});

it("keeps horizontal surface details clear of coplanar hull and armor faces", () => {
  const overlaps: string[] = [];
  const ray = new THREE.Raycaster();
  ray.far = 0.02;
  const down = new THREE.Vector3(0, -1, 0);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const sample = new THREE.Vector3();
  for (const shipClass of ALL_SHIP_CLASSES) {
    const geometry = getShipHullGeometries(shipClass);
    const surfaces = [new THREE.Mesh(geometry.hull), new THREE.Mesh(geometry.armor)];
    for (const layer of ["dark", "accent", "light"] as const) {
      const positions = geometry[layer].getAttribute("position");
      const normals = geometry[layer].getAttribute("normal");
      for (let i = 0; i < positions.count; i += 3) {
        if (normals.getY(i) < 0.99) continue;
        a.fromBufferAttribute(positions, i);
        b.fromBufferAttribute(positions, i + 1);
        c.fromBufferAttribute(positions, i + 2);
        // Interior samples avoid counting adjoining polygon edges as overlap.
        for (const weights of [[0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]]) {
          sample.copy(a).multiplyScalar(weights[0]!).addScaledVector(b, weights[1]!).addScaledVector(c, weights[2]!);
          const y = sample.y;
          sample.y += 0.01;
          ray.set(sample, down);
          const hit = ray.intersectObjects(surfaces).find(hit => Math.abs(hit.point.y - y) < 0.005);
          if (hit) {
            overlaps.push(`${shipClass} ${layer} at ${sample.x.toFixed(2)}, ${y.toFixed(3)}, ${sample.z.toFixed(2)}`);
            break;
          }
        }
      }
    }
    surfaces.forEach(surface => (surface.material as THREE.Material).dispose());
  }
  expect(overlaps).toEqual([]);
});
