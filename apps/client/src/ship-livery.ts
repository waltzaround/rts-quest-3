import * as THREE from "three";

export interface ShipLivery {
  origin: THREE.Vector3;
  size: THREE.Vector3;
  teamColor: THREE.Color;
}

/** One projection per class, shared by close/medium/simplified geometry so
 * markings don't slide when the renderer changes detail levels.
 */
export function createShipLivery(surfaces: readonly THREE.BufferGeometry[], teamColor: THREE.ColorRepresentation = 0xffffff): ShipLivery {
  const bounds = new THREE.Box3();
  for (const surface of surfaces) {
    if (!surface.boundingBox) surface.computeBoundingBox();
    bounds.union(surface.boundingBox!);
  }
  return {
    origin: bounds.min.clone(),
    size: bounds.getSize(new THREE.Vector3()).max(new THREE.Vector3(0.001, 0.001, 0.001)),
    teamColor: new THREE.Color(teamColor),
  };
}

// Analytical paint masks, not projected meshes: no extra geometry, textures,
// instance attributes or draw calls. Paint receives the hull's normal lighting.
export const SHIP_LIVERY_GLSL = /* glsl */`
  uniform vec3 shipLiveryOrigin;
  uniform vec3 shipLiverySize;
  uniform vec3 shipLiveryTeam;

  float liveryBox(vec2 p, vec2 center, vec2 halfSize, vec2 aa) {
    vec2 outside = smoothstep(-aa, aa, abs(p - center) - halfSize);
    return (1.0 - outside.x) * (1.0 - outside.y);
  }

  float shipLiveryMask(vec3 position, vec3 normal) {
    vec3 q = (position - shipLiveryOrigin) / shipLiverySize;
    vec2 p = vec2(q.x * 2.0 - 1.0, q.z);
    vec2 aa = max(fwidth(p) * 0.7, vec2(0.0005));
    float top = smoothstep(0.2, 0.65, normal.y);

    // A narrow chevron across the bow, separate port/starboard shoulder
    // panels and small stern tabs. Most of the hull stays unpainted.
    float bow = 1.0 - smoothstep(0.022 - aa.y, 0.022 + aa.y,
      abs(p.y - (0.77 - abs(p.x) * 0.09)));
    vec2 shoulder = vec2(abs(p.x), p.y + max(0.0, abs(p.x) - 0.55) * 0.12);
    float panels = liveryBox(shoulder, vec2(0.7, 0.33), vec2(0.14, 0.105), aa);
    float stern = liveryBox(vec2(abs(p.x), p.y), vec2(0.62, 0.135), vec2(0.18, 0.017), aa);

    // Circular squadron badge, kept physically round on long narrow ships.
    vec2 badge = vec2((p.x + 0.24) * shipLiverySize.x * 0.5,
      (p.y - 0.53) * shipLiverySize.z);
    float radius = min(shipLiverySize.x * 0.065, shipLiverySize.z * 0.024);
    float badgeAA = max(fwidth(length(badge)), 0.0005);
    float ring = 1.0 - smoothstep(radius * 0.16, radius * 0.16 + badgeAA,
      abs(length(badge) - radius));
    float bar = liveryBox(badge, vec2(0.0), vec2(radius * 0.16, radius * 0.52), vec2(badgeAA));
    float badgeFade = 1.0 - smoothstep(radius * 0.4, radius, badgeAA);

    // A contained flank panel rather than tinting every vertical surface.
    vec2 flankAA = max(fwidth(q.zy) * 0.7, vec2(0.0005));
    float flank = liveryBox(q.zy, vec2(0.43, 0.38), vec2(0.13, 0.055), flankAA)
      * smoothstep(0.45, 0.8, abs(normal.x));
    return max(flank, max(max(bow, panels), max(stern, max(ring, bar) * badgeFade)) * top);
  }
`;
