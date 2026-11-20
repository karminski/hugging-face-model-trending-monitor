/** 1-bit bitmap. A value of 1 means ink (black on the RLCD), 0 means paper. */
export type Ink = 0 | 1;

export class Bitmap {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    fill: Ink = 0,
  ) {
    this.data = new Uint8Array(width * height).fill(fill);
  }

  get(x: number, y: number): Ink {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.data[y * this.width + x] as Ink;
  }

  set(x: number, y: number, v: Ink): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.data[y * this.width + x] = v;
  }

  fillRect(x: number, y: number, w: number, h: number, v: Ink): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, v);
  }

  fillRoundRect(x: number, y: number, w: number, h: number, r: number, v: Ink): void {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) if (insideRoundRect(xx, yy, x, y, w, h, r)) this.set(xx, yy, v);
  }

  /** Stroke of `t` pixels drawn inside the rounded rect bounds. */
  strokeRoundRect(x: number, y: number, w: number, h: number, r: number, v: Ink, t = 1): void {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        if (!insideRoundRect(xx, yy, x, y, w, h, r)) continue;
        if (!insideRoundRect(xx, yy, x + t, y + t, w - 2 * t, h - 2 * t, Math.max(0, r - t)))
          this.set(xx, yy, v);
      }
  }

  /** Copy `src` (or its sub-rect) onto this bitmap at (dx, dy), optionally clipped to a rounded rect. */
  blit(
    src: Bitmap,
    dx: number,
    dy: number,
    opts: { sx?: number; sy?: number; w?: number; h?: number; clipRadius?: number } = {},
  ): void {
    const sx = opts.sx ?? 0;
    const sy = opts.sy ?? 0;
    const w = opts.w ?? src.width;
    const h = opts.h ?? src.height;
    const r = opts.clipRadius ?? 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (r > 0 && !insideRoundRect(x, y, 0, 0, w, h, r)) continue;
        this.set(dx + x, dy + y, src.get(sx + x, sy + y));
      }
  }

  inkRatio(): number {
    let n = 0;
    for (const v of this.data) n += v;
    return n / this.data.length;
  }

  /** Row-major, MSB first, 1 bit per pixel, 1 = ink. */
  pack(): Uint8Array {
    const stride = Math.ceil(this.width / 8);
    const out = new Uint8Array(stride * this.height);
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++)
        if (this.data[y * this.width + x]) out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    return out;
  }

  /** 8-bit grayscale pixels (ink = 0, paper = 255), nearest-neighbour scaled. */
  toGray(scale = 1): { width: number; height: number; pixels: Uint8Array } {
    const w = this.width * scale;
    const h = this.height * scale;
    const pixels = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        pixels[y * w + x] = this.data[Math.floor(y / scale) * this.width + Math.floor(x / scale)] ? 0 : 255;
    return { width: w, height: h, pixels };
  }
}

export function insideRoundRect(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): boolean {
  if (px < x || py < y || px >= x + w || py >= y + h) return false;
  if (r <= 0) return true;
  const cx = px < x + r ? x + r : px >= x + w - r ? x + w - r : null;
  const cy = py < y + r ? y + r : py >= y + h - r ? y + h - r : null;
  if (cx === null || cy === null) return true;
  const dx = px + 0.5 - cx;
  const dy = py + 0.5 - cy;
  return dx * dx + dy * dy <= r * r;
}
