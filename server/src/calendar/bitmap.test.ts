import { describe, expect, it } from "vitest";
import { Bitmap, insideRoundRect } from "./bitmap.js";

describe("Bitmap", () => {
  it("packs 400x300 into 15000 bytes, row-major MSB first", () => {
    const b = new Bitmap(400, 300);
    b.set(0, 0, 1);
    b.set(9, 0, 1);
    b.set(399, 299, 1);
    const packed = b.pack();
    expect(packed.length).toBe(15000);
    expect(packed[0]).toBe(0x80);
    expect(packed[1]).toBe(0x40);
    expect(packed[14999]).toBe(0x01);
    expect(packed.reduce((n, v) => n + v, 0)).toBe(0x80 + 0x40 + 0x01);
  });

  it("clips rounded corners", () => {
    expect(insideRoundRect(0, 0, 0, 0, 20, 20, 8)).toBe(false);
    expect(insideRoundRect(10, 0, 0, 0, 20, 20, 8)).toBe(true);
    expect(insideRoundRect(19, 19, 0, 0, 20, 20, 0)).toBe(true);
  });

  it("strokes only the border", () => {
    const b = new Bitmap(20, 20);
    b.strokeRoundRect(0, 0, 20, 20, 4, 1);
    expect(b.get(10, 0)).toBe(1);
    expect(b.get(10, 1)).toBe(0);
    expect(b.get(10, 10)).toBe(0);
    expect(b.get(0, 0)).toBe(0);
  });
});
