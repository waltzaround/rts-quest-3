import { describe, expect, it } from "vitest";
import { Group, Vector2, Vector3 } from "three";
import { wristButton, wristSurfaceUV, WristPress } from "./quest-wrist-input";

const uv = (x: number, y: number, height = 700) => new Vector2(x / 1200, 1 - y / height);
describe("wrist menu input", () => {
  it("captures a button once on press even when the menu moves before release", () => {
    const press = new WristPress<string>();
    expect(press.sample(false, "pause")).toBeNull();
    expect(press.sample(true, "pause")).toBe("pause");
    expect(press.sample(true, "restart")).toBeNull();
    expect(press.sample(false, null)).toBeNull();
    expect(press.sample(true, "demo")).toBe("demo");
  });
  it("requires release after tracking loss and never turns a world grab into a menu press", () => {
    const press = new WristPress<string>();
    expect(press.sample(true, null)).toBeNull();
    expect(press.sample(true, "pause")).toBeNull();
    press.sample(false, null, false);
    expect(press.sample(true, "pause")).toBeNull();
    press.sample(false, null);
    expect(press.sample(true, "pause")).toBe("pause");
    press.cancel(); expect(press.sample(true, "demo")).toBeNull();
  });
  it("finds fingertips on a translated, rotated, small tool panel using physical depth tolerance", () => {
    const panel = new Group(); panel.position.set(0.4, 1.2, -0.5); panel.rotation.set(-0.3, 0.6, 0.2); panel.scale.setScalar(0.32);
    const point = panel.localToWorld(new Vector3(0.2, -0.1, 0.05 / 0.32));
    const hit = wristSurfaceUV(panel, 1.55, 0.827, point)!;
    expect(hit.x).toBeCloseTo(0.2 / 1.55 + 0.5); expect(hit.y).toBeCloseTo(-0.1 / 0.827 + 0.5);
    expect(wristSurfaceUV(panel, 1.55, 0.827, panel.localToWorld(new Vector3(0, 0, 0.061 / 0.32)))).toBeNull();
  });
  it("maps every cuff button, audio and next fight, tabs and actions without activating headers or blank slots", () => {
    for (let i = 0; i < 6; i++) expect(wristButton("hud", uv(200 + i % 3 * 400, 280 + Math.floor(i / 3) * 160))).toBe(`hud:${i}`);
    expect(wristButton("hud", uv(1100, 600))).toBe("hud:7");
    expect(wristButton("hud", uv(200, 100))).toBeNull();
    expect(wristButton("panel", uv(100, 130, 640))).toBe("tab:0");
    expect(wristButton("panel", uv(100, 210, 640))).toBe("action:0");
    expect(wristButton("panel", uv(1000, 440, 640), 9)).toBeNull();
    expect(wristButton("panel", uv(100, 500, 640))).toBeNull();
  });
});
