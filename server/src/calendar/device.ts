import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { Bitmap } from "./bitmap.js";
import { LAYOUT, type Rect, SCREEN, TICKER_VIEWPORT } from "./layout.js";
import { DITHERS, type Dither } from "./pixelate.js";

/**
 * Binary bundle for the ESP32 calendar page. All integers are little-endian;
 * bitmaps are 1bpp, row-major, LSB-first (XBM bit order, 1 = ink) so the
 * firmware can hand them to u8g2 drawXBM unchanged.
 *
 * Header (40 bytes):
 *   0  "CAL1"        4  u16 version      6  u16 modeCount    8  u16 fps
 *   10 u16 scene x,y,w,h                 18 u16 ticker x,y,w,h
 *   26 u16 stripHeight 28 u16 scrolls    30 u16 entryCount   32 u32 id
 *   36 u16 defaultMode 38 u16 reserved
 * Then: entryCount x u16 entry y; modeCount x 16-byte mode records
 * (12-byte NUL-padded ASCII name, u16 frameCount, u16 reserved); base frame
 * (400x300); each mode's scene loop in mode order; ticker strip (ticker
 * width x stripHeight).
 *
 * A scene loop is the first scene crop (scene rect) followed by frameCount-1
 * deltas, delta k turning frame k into frame k+1. A delta is a u32 byte length
 * then runs of (u16 skip, u16 count, count bytes XORed into the frame at the
 * cursor). Consecutive frames differ by well under 1% of pixels, so this keeps
 * four dithers smaller than one uncompressed loop.
 */
export const DEVICE_MAGIC = "CAL1";
export const DEVICE_VERSION = 3;
export const DEVICE_HEADER_SIZE = 40;
export const DEVICE_MODE_SIZE = 16;
export const DEVICE_DEFAULT_MODE = "bayer4";

interface TickerMeta {
  stripHeight?: number;
  scrolls?: boolean;
  entries?: { y: number }[];
}

interface AnimationMeta {
  frames?: number;
  fps?: number;
  dither?: string;
}

function readPngBitmap(path: string): Bitmap {
  const png = PNG.sync.read(readFileSync(path));
  const bmp = new Bitmap(png.width, png.height);
  for (let i = 0; i < png.width * png.height; i++) bmp.data[i] = png.data[i * 4]! < 128 ? 1 : 0;
  return bmp;
}

function packXbm(bmp: Bitmap, r: Rect): Buffer {
  const stride = Math.ceil(r.w / 8);
  const out = Buffer.alloc(stride * r.h);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) if (bmp.get(r.x + x, r.y + y)) out[y * stride + (x >> 3)]! |= 1 << (x & 7);
  return out;
}

function readJson<T>(path: string): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : ({} as T);
}

/** FNV-1a, so the device can tell bundles apart without keeping the dir name. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function readFrame(path: string): Bitmap {
  const bmp = readPngBitmap(path);
  if (bmp.width !== SCREEN.width || bmp.height !== SCREEN.height) throw new Error(`unexpected frame size: ${path}`);
  return bmp;
}

/** Full composed frames, so the scene crop keeps the rounded corners, border and labels drawn over it. */
function framePaths(dir: string, anim: AnimationMeta, algo: Dither): string[] {
  const count = anim.frames ?? 0;
  const loop = (folder: string) =>
    Array.from({ length: count }, (_, i) => join(folder, `frame-${String(i).padStart(2, "0")}.png`));
  for (const folder of [join(dir, "animation", algo), ...(anim.dither === algo ? [join(dir, "animation")] : [])]) {
    const paths = loop(folder);
    if (paths.length && paths.every((p) => existsSync(p))) return paths;
  }
  // Outputs written before every dither was animated only have a still per dither.
  const still = join(dir, "variants", `frame-${algo}.png`);
  return existsSync(still) ? [still] : [];
}

/** A run header costs 4 bytes, so equal gaps shorter than this are XORed through. */
const MIN_RUN_GAP = 4;

export function encodeDelta(from: Buffer, to: Buffer): Buffer {
  const parts: Buffer[] = [];
  let cursor = 0;
  let i = 0;
  while (i < to.length) {
    if (from[i] === to[i]) {
      i++;
      continue;
    }
    let end = i + 1;
    for (let j = end; j < to.length && j - end < MIN_RUN_GAP; j++) if (from[j] !== to[j]) end = j + 1;
    const run = Buffer.alloc(4 + end - i);
    run.writeUInt16LE(i - cursor, 0);
    run.writeUInt16LE(end - i, 2);
    for (let k = i; k < end; k++) run[4 + k - i] = from[k]! ^ to[k]!;
    parts.push(run);
    cursor = end;
    i = end;
  }
  const body = Buffer.concat(parts);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length, 0);
  return Buffer.concat([length, body]);
}

/** Inverse of encodeDelta, for tests. */
export function applyDelta(frame: Buffer, delta: Buffer): void {
  const end = 4 + delta.readUInt32LE(0);
  let cursor = 0;
  for (let p = 4; p < end; ) {
    cursor += delta.readUInt16LE(p);
    const count = delta.readUInt16LE(p + 2);
    for (let k = 0; k < count; k++) frame[cursor + k]! ^= delta[p + 4 + k]!;
    cursor += count;
    p += 4 + count;
  }
}

function encodeLoop(frames: Buffer[]): Buffer {
  return Buffer.concat([frames[0]!, ...frames.slice(1).map((f, i) => encodeDelta(frames[i]!, f))]);
}

interface Mode {
  name: string;
  frames: Buffer[];
}

export function buildDeviceBundle(dir: string, name: string): Buffer {
  const base = readFrame(join(dir, "frame.png"));
  const anim = readJson<AnimationMeta>(join(dir, "animation.json"));
  const modes: Mode[] = DITHERS.map((algo) => ({
    name: algo,
    frames: framePaths(dir, anim, algo).map((p) => packXbm(readFrame(p), LAYOUT.scene)),
  })).filter((m) => m.frames.length > 0);
  if (modes.length === 0) modes.push({ name: "still", frames: [packXbm(base, LAYOUT.scene)] });
  const defaultMode = Math.max(0, modes.findIndex((m) => m.name === DEVICE_DEFAULT_MODE));

  const ticker = readJson<TickerMeta>(join(dir, "ticker.json"));
  const v = TICKER_VIEWPORT;
  let strip: Buffer;
  let stripHeight: number;
  if (existsSync(join(dir, "ticker.png"))) {
    const bmp = readPngBitmap(join(dir, "ticker.png"));
    stripHeight = bmp.height;
    strip = packXbm(bmp, { x: 0, y: 0, w: v.w, h: stripHeight });
  } else {
    stripHeight = 0;
    strip = Buffer.alloc(0);
  }
  const entries = (ticker.entries ?? []).map((e) => e.y).filter((y) => y >= 0 && y < stripHeight);

  const modeTable = DEVICE_HEADER_SIZE + entries.length * 2;
  const header = Buffer.alloc(modeTable + modes.length * DEVICE_MODE_SIZE);
  header.write(DEVICE_MAGIC, 0, "ascii");
  const s = LAYOUT.scene;
  const fields = [DEVICE_VERSION, modes.length, anim.fps ?? 4, s.x, s.y, s.w, s.h, v.x, v.y, v.w, v.h];
  fields.forEach((f, i) => header.writeUInt16LE(f, 4 + i * 2));
  header.writeUInt16LE(stripHeight, 26);
  header.writeUInt16LE(ticker.scrolls && stripHeight > 0 ? 1 : 0, 28);
  header.writeUInt16LE(entries.length, 30);
  header.writeUInt32LE(hash32(name), 32);
  header.writeUInt16LE(defaultMode, 36);
  entries.forEach((y, i) => header.writeUInt16LE(y, DEVICE_HEADER_SIZE + i * 2));
  modes.forEach((m, i) => {
    const at = modeTable + i * DEVICE_MODE_SIZE;
    header.write(m.name.slice(0, 11), at, "ascii");
    header.writeUInt16LE(m.frames.length, at + 12);
  });

  return Buffer.concat([
    header,
    packXbm(base, { x: 0, y: 0, w: SCREEN.width, h: SCREEN.height }),
    ...modes.map((m) => encodeLoop(m.frames)),
    strip,
  ]);
}

/** Keeps the last built bundle, since outputs never change once written. */
export class DeviceBundleCache {
  private name: string | null = null;
  private data: Buffer | null = null;

  get(dir: string, name: string): Buffer {
    if (this.name !== name || !this.data) {
      this.data = buildDeviceBundle(dir, name);
      this.name = name;
    }
    return this.data;
  }
}
