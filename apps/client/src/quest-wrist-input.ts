import { Vector2, Vector3, type Object3D } from "three";

/** Physical contact tolerance stays constant when the tool panel is scaled. */
export function wristSurfaceUV(surface: Object3D, width: number, height: number, point: Vector3): Vector2 | null {
  surface.updateWorldMatrix(true, false);
  const local = surface.worldToLocal(point.clone());
  const scale = surface.getWorldScale(new Vector3());
  if (Math.abs(local.z * scale.z) > 0.06 || Math.abs(local.x) > width / 2 || Math.abs(local.y) > height / 2) return null;
  return new Vector2(local.x / width + 0.5, local.y / height + 0.5);
}
export function wristButton(surface: "hud" | "panel", uv: Vector2, actionCount = 12): string | null {
  const x = uv.x * 1200, y = (1 - uv.y) * (surface === "hud" ? 700 : 640);
  if (x < 0 || x >= 1200) return null;
  if (surface === "hud") {
    if (y < 200 || y >= 680) return null;
    return `hud:${y >= 520 ? (x < 600 ? 6 : 7) : Math.floor(x / 400) + Math.floor((y - 200) / 160) * 3}`;
  }
  if (x < 24) return null;
  const column = Math.floor((x - 24) / 294);
  if (column >= 4 || (x - 24) % 294 >= 282) return null;
  if (y >= 104 && y < 156) return `tab:${column}`;
  if (y < 176 || y >= 476 || (y - 176) % 104 >= 92) return null;
  const index = Math.floor((y - 176) / 104) * 4 + column;
  return index < actionCount ? `action:${index}` : null;
}
/** Capture on press, never re-hit a moving menu on release. */
export class WristPress<T> {
  private down = false;
  private blocked = false;
  sample(pressed: boolean, target: T | null, tracked = true): T | null {
    if (!tracked) { this.blocked = true; this.down = false; return null; }
    if (!pressed) { this.down = false; this.blocked = false; return null; }
    if (this.blocked || this.down) return null;
    this.down = true;
    return target;
  }
  cancel(): void { this.blocked = true; this.down = false; }
}
