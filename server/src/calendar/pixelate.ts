import { Bitmap, type Ink } from "./bitmap.js";

export const DITHERS = ["atkinson", "bayer4", "floyd", "threshold"] as const;
export type Dither = (typeof DITHERS)[number];

/** Rec. 709 luma, 0 = black, 255 = white. */
export function toGray(rgba: Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++)
    out[i] = 0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!;
  return out;
}

export interface LevelsRange {
  lo: number;
  hi: number;
}

export function levelsRange(gray: Float32Array, lowPct = 0.01, highPct = 0.99): LevelsRange {
  const sorted = Float32Array.from(gray).sort();
  return {
    lo: sorted[Math.floor(lowPct * (sorted.length - 1))]!,
    hi: sorted[Math.floor(highPct * (sorted.length - 1))]!,
  };
}

/** Stretches [lo, hi] to full scale and applies gamma. */
export function applyLevels(gray: Float32Array, { lo, hi }: LevelsRange, gamma = 1): Float32Array {
  const span = Math.max(1, hi - lo);
  return gray.map((v) => 255 * Math.pow(Math.min(1, Math.max(0, (v - lo) / span)), gamma));
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function diffuse(
  gray: Float32Array,
  width: number,
  height: number,
  kernel: [dx: number, dy: number, weight: number][],
): Uint8Array {
  const buf = Float32Array.from(gray);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = buf[i]!;
      const ink = old < 128 ? 1 : 0;
      out[i] = ink;
      const err = old - (ink ? 0 : 255);
      for (const [dx, dy, w] of kernel) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < width && ny < height) buf[ny * width + nx]! += err * w;
      }
    }
  return out;
}

/** Returns a 1-bit image where 1 = ink. */
export function dither(gray: Float32Array, width: number, height: number, algo: Dither): Bitmap {
  let ink: Uint8Array;
  switch (algo) {
    case "atkinson":
      ink = diffuse(gray, width, height, [
        [1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8],
      ]);
      break;
    case "floyd":
      ink = diffuse(gray, width, height, [
        [1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16],
      ]);
      break;
    case "bayer4":
      ink = new Uint8Array(width * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const t = ((BAYER4[(y & 3) * 4 + (x & 3)]! + 0.5) / 16) * 255;
          ink[y * width + x] = gray[y * width + x]! < t ? 1 : 0;
        }
      break;
    case "threshold":
      ink = Uint8Array.from(gray, (v) => (v < 128 ? 1 : 0));
      break;
  }
  const bmp = new Bitmap(width, height);
  bmp.data.set(ink);
  return bmp;
}

export function upscale(src: Bitmap, scale: number, width: number, height: number): Bitmap {
  const out = new Bitmap(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      out.set(x, y, src.get(Math.min(src.width - 1, Math.floor(x / scale)), Math.min(src.height - 1, Math.floor(y / scale))) as Ink);
  return out;
}

export interface PixelateResult {
  bitmap: Bitmap;
  inkRatio: number;
  /** Std-dev of the raw luma; near zero means a flat, empty render. */
  contrast: number;
  levels: LevelsRange;
}

/** Pass `levels` from the first frame when pixelating an animation so brightness does not pump. */
export function pixelate(
  rgba: Uint8Array,
  renderW: number,
  renderH: number,
  scale: number,
  outW: number,
  outH: number,
  algo: Dither,
  levels?: LevelsRange,
): PixelateResult {
  const raw = toGray(rgba, renderW, renderH);
  let mean = 0;
  for (const v of raw) mean += v;
  mean /= raw.length;
  let variance = 0;
  for (const v of raw) variance += (v - mean) ** 2;
  const contrast = Math.sqrt(variance / raw.length);
  const range = levels ?? levelsRange(raw);
  const low = dither(applyLevels(raw, range), renderW, renderH, algo);
  const bitmap = upscale(low, scale, outW, outH);
  return { bitmap, inkRatio: bitmap.inkRatio(), contrast, levels: range };
}

/** Luma change (after levels) below which an error-diffused pixel keeps the first frame's ink. */
const STABLE_DELTA = 6;

/**
 * Dithers animation frames with one shared levels range. Error diffusion
 * re-dithers the whole frame, so a moving pixel would ripple noise across
 * static areas; those pixels keep the first frame's ink instead.
 */
export function pixelateFrames(
  frames: Uint8Array[],
  renderW: number,
  renderH: number,
  scale: number,
  outW: number,
  outH: number,
  algo: Dither,
  levels: LevelsRange,
): Bitmap[] {
  const stabilize = algo === "atkinson" || algo === "floyd";
  let firstGray: Float32Array | null = null;
  let firstInk: Bitmap | null = null;
  return frames.map((rgba) => {
    const gray = applyLevels(toGray(rgba, renderW, renderH), levels);
    const low = dither(gray, renderW, renderH, algo);
    if (!firstGray || !firstInk) {
      firstGray = gray;
      firstInk = low;
    } else if (stabilize) {
      for (let i = 0; i < gray.length; i++)
        if (Math.abs(gray[i]! - firstGray[i]!) <= STABLE_DELTA) low.data[i] = firstInk.data[i]!;
    }
    return upscale(low, scale, outW, outH);
  });
}

/** Fraction of pixels that differ between two same-sized bitmaps. */
export function frameDiff(a: Bitmap, b: Bitmap): number {
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n / a.data.length;
}

export interface AnimationStats {
  /** Mean changed-pixel fraction between consecutive frames, including last -> first. */
  motion: number;
  maxStep: number;
  /** Difference between t = 0 and t = 1; non-zero means the loop has a visible seam. */
  loopSeam: number;
}

export function animationStats(frames: Bitmap[], end: Bitmap): AnimationStats {
  const steps = frames.map((f, i) => frameDiff(f, frames[(i + 1) % frames.length]!));
  return {
    motion: steps.reduce((s, v) => s + v, 0) / steps.length,
    maxStep: Math.max(...steps),
    loopSeam: frameDiff(frames[0]!, end),
  };
}

export function animationProblem(s: AnimationStats): string | null {
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  if (s.loopSeam > Math.max(0.002, s.motion * 0.3))
    return `the loop is not seamless: frame t=1 differs from t=0 by ${pct(s.loopSeam)} of pixels; every motion must be periodic in t with period 1`;
  if (s.motion < 0.002)
    return `the animation barely moves (${pct(s.motion)} pixels change per frame); add visible t-driven motion such as falling snow/rain, drifting clouds, smoke, flickering lights or swaying objects`;
  if (s.maxStep > 0.3)
    return `the animation changes too much between frames (up to ${pct(s.maxStep)} of pixels); keep camera, lights and large objects still and animate only small elements`;
  return null;
}

/** Why a pixelated scene is unusable, or null if it looks fine. */
export function sceneProblem(r: PixelateResult): string | null {
  if (r.contrast < 12) return `the render is almost flat (luma std-dev ${r.contrast.toFixed(1)}); objects are missing, off-camera, or unlit`;
  if (r.inkRatio > 0.85) return `the render is almost entirely black (${Math.round(r.inkRatio * 100)}% ink); add light or brighten the background`;
  if (r.inkRatio < 0.04) return `the render is almost entirely white (${Math.round(r.inkRatio * 100)}% ink); add darker objects or shadows`;
  return null;
}
