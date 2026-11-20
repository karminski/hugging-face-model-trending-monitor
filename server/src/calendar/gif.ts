import type { Bitmap } from "./bitmap.js";

const MIN_CODE_SIZE = 2;

class ByteWriter {
  private bytes: number[] = [];
  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }
  u16(v: number): void {
    this.u8(v);
    this.u8(v >> 8);
  }
  ascii(s: string): void {
    for (const ch of s) this.u8(ch.charCodeAt(0));
  }
  raw(data: ArrayLike<number>): void {
    for (let i = 0; i < data.length; i++) this.u8(data[i]!);
  }
  result(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** GIF variable-width LZW, returned as length-prefixed sub-blocks. */
export function lzwEncode(indices: Uint8Array, minCodeSize = MIN_CODE_SIZE): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let table = new Map<number, number>();
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  const emit = (code: number) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  let cur = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (cur << 8) | k;
    const hit = table.get(key);
    if (hit !== undefined) {
      cur = hit;
      continue;
    }
    emit(cur);
    if (next === 4096) {
      emit(clear);
      table = new Map();
      next = eoi + 1;
      codeSize = minCodeSize + 1;
    } else {
      if (next >= 1 << codeSize) codeSize++;
      table.set(key, next++);
    }
    cur = k;
  }
  emit(cur);
  emit(eoi);
  if (bits > 0) out.push(acc & 0xff);

  const blocks: number[] = [];
  for (let i = 0; i < out.length; i += 255) {
    const chunk = out.slice(i, i + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return blocks;
}

/** Looping 1-bit GIF; ink pixels are black. */
export function encodeGif(frames: Bitmap[], fps: number, scale = 1): Uint8Array {
  const w = frames[0]!.width * scale;
  const h = frames[0]!.height * scale;
  const delay = Math.round(100 / fps);
  const g = new ByteWriter();
  g.ascii("GIF89a");
  g.u16(w);
  g.u16(h);
  g.u8(0x80); // global color table, 2 entries
  g.u8(0);
  g.u8(0);
  g.raw([255, 255, 255, 0, 0, 0]);
  g.raw([0x21, 0xff, 0x0b]);
  g.ascii("NETSCAPE2.0");
  g.raw([0x03, 0x01, 0x00, 0x00, 0x00]);
  for (const f of frames) {
    g.raw([0x21, 0xf9, 0x04, 0x00]);
    g.u16(delay);
    g.raw([0x00, 0x00]);
    g.u8(0x2c);
    g.u16(0);
    g.u16(0);
    g.u16(w);
    g.u16(h);
    g.u8(0);
    g.u8(MIN_CODE_SIZE);
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) px[y * w + x] = f.data[Math.floor(y / scale) * f.width + Math.floor(x / scale)]!;
    g.raw(lzwEncode(px));
  }
  g.u8(0x3b);
  return g.result();
}
