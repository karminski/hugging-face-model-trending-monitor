import { describe, expect, it } from "vitest";
import { DITHERS, dither, pixelate, pixelateFrames, sceneProblem } from "./pixelate.js";

function gradient(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.round((x / (w - 1)) * 255);
      rgba.set([v, v, v, 255], (y * w + x) * 4);
    }
  return rgba;
}

describe("dithering", () => {
  for (const algo of DITHERS)
    it(`${algo} outputs only 0/1 and darker areas get more ink`, () => {
      const w = 64;
      const h = 32;
      const gray = Float32Array.from({ length: w * h }, (_, i) => ((i % w) / (w - 1)) * 255);
      const bmp = dither(gray, w, h, algo);
      expect(bmp.data.every((v) => v === 0 || v === 1)).toBe(true);
      const inkIn = (x0: number, x1: number) => {
        let n = 0;
        for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) n += bmp.get(x, y);
        return n;
      };
      expect(inkIn(0, 16)).toBeGreaterThan(inkIn(48, 64));
    });

  it("upscales to the requested panel size", () => {
    const r = pixelate(gradient(131, 144), 131, 144, 2, 262, 288, "atkinson");
    expect([r.bitmap.width, r.bitmap.height]).toEqual([262, 288]);
    expect(r.bitmap.get(0, 0)).toBe(r.bitmap.get(1, 1));
    expect(sceneProblem(r)).toBeNull();
  });

  for (const algo of ["atkinson", "floyd"] as const)
    it(`${algo} animation leaves static areas untouched by a moving spot`, () => {
      const w = 64;
      const h = 32;
      const a = gradient(w, h);
      const b = Uint8Array.from(a);
      // A black block appears near the top-left of the second frame.
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) b.set([0, 0, 0, 255], (y * w + x) * 4);
      const [f0, f1] = pixelateFrames([a, b], w, h, 1, w, h, algo, { lo: 0, hi: 255 });
      let changedFar = 0;
      for (let y = 8; y < h; y++) for (let x = 8; x < w; x++) changedFar += f0!.get(x, y) !== f1!.get(x, y) ? 1 : 0;
      expect(changedFar).toBe(0);
      expect(f1!.get(0, 0)).toBe(1);
    });

  it("flags flat renders", () => {
    const flat = new Uint8Array(32 * 32 * 4).fill(200);
    expect(sceneProblem(pixelate(flat, 32, 32, 1, 32, 32, "atkinson"))).toMatch(/flat/);
  });
});
