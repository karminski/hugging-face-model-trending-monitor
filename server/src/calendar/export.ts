import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";
import type { Bitmap } from "./bitmap.js";

function write(path: string, data: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

export function writeBitmapPng(path: string, bmp: Bitmap, scale = 1): void {
  const { width, height, pixels } = bmp.toGray(scale);
  const png = new PNG({ width, height, colorType: 0, inputColorType: 0, inputHasAlpha: false, bitDepth: 8 });
  png.data = Buffer.from(pixels);
  write(path, PNG.sync.write(png, { colorType: 0, inputColorType: 0, inputHasAlpha: false }));
}

/** Writes an RGBA buffer, nearest-neighbour scaled. */
export function writeRgbaPng(path: string, rgba: Uint8Array, width: number, height: number, scale = 1): void {
  const png = new PNG({ width: width * scale, height: height * scale });
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const si = (Math.floor(y / scale) * width + Math.floor(x / scale)) * 4;
      const di = (y * png.width + x) * 4;
      png.data[di] = rgba[si]!;
      png.data[di + 1] = rgba[si + 1]!;
      png.data[di + 2] = rgba[si + 2]!;
      png.data[di + 3] = 255;
    }
  write(path, PNG.sync.write(png));
}

export function writeBin(path: string, bmp: Bitmap): void {
  write(path, bmp.pack());
}

export function writeBytes(path: string, data: Uint8Array): void {
  write(path, data);
}

export function writeJson(path: string, value: unknown): void {
  write(path, JSON.stringify(value, null, 2));
}

export function writeText(path: string, text: string): void {
  write(path, text);
}
