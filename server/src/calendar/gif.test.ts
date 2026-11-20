import { describe, expect, it } from "vitest";
import { Bitmap } from "./bitmap.js";
import { encodeGif, lzwEncode } from "./gif.js";
import { animationProblem, animationStats } from "./pixelate.js";

/** Reference GIF LZW decoder for round-trip checks. */
function lzwDecode(blocks: number[], minCodeSize: number): number[] {
  const data: number[] = [];
  for (let i = 0; blocks[i]! > 0; i += blocks[i]! + 1) data.push(...blocks.slice(i + 1, i + 1 + blocks[i]!));
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = Array.from({ length: eoi + 1 }, (_, i) => [i]);
    codeSize = minCodeSize + 1;
  };
  reset();
  const out: number[] = [];
  let pos = 0;
  let prev: number[] | null = null;
  const read = () => {
    let v = 0;
    for (let b = 0; b < codeSize; b++, pos++) v |= ((data[pos >> 3]! >> (pos & 7)) & 1) << b;
    return v;
  };
  for (;;) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code]!;
    else entry = [...prev!, prev![0]!];
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]!]);
    prev = entry;
    if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
  }
  return out;
}

describe("GIF encoder", () => {
  it("round-trips LZW data, including table resets", () => {
    let s = 1;
    const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) >>> 16) & 1;
    const px = Uint8Array.from({ length: 200000 }, (_, i) => (i % 97 < 40 ? rand() : (i >> 5) & 1));
    expect(lzwDecode(lzwEncode(px), 2)).toEqual([...px]);
  });

  it("writes a looping GIF89a with one image per frame", () => {
    const a = new Bitmap(8, 4);
    const b = new Bitmap(8, 4, 1);
    const gif = encodeGif([a, b], 4, 2);
    expect(String.fromCharCode(...gif.slice(0, 6))).toBe("GIF89a");
    expect(gif[6]! | (gif[7]! << 8)).toBe(16);
    expect(String.fromCharCode(...gif.slice(22, 33))).toBe("NETSCAPE2.0");
    expect(gif.filter((v, i) => v === 0x2c && gif[i - 1] === 0x00).length).toBeGreaterThanOrEqual(2);
    expect(gif.at(-1)).toBe(0x3b);
  });
});

describe("animation checks", () => {
  const frame = (shift: number) => {
    const b = new Bitmap(100, 100);
    b.fillRect(shift, 40, 10, 10, 1);
    return b;
  };

  it("accepts a seamless moving loop", () => {
    const frames = [0, 10, 20, 30].map(frame);
    const stats = animationStats(frames, frame(0));
    expect(stats.loopSeam).toBe(0);
    expect(animationProblem(stats)).toBeNull();
  });

  it("rejects a visible seam and a static loop", () => {
    const frames = [0, 10, 20, 30].map(frame);
    expect(animationProblem(animationStats(frames, frame(40)))).toMatch(/seamless/);
    const still = [0, 0, 0].map(frame);
    expect(animationProblem(animationStats(still, frame(0)))).toMatch(/barely moves/);
  });
});
