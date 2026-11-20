import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { ROOT_DIR } from "../config.js";
import { type BdfFont, loadBdf, mergeFonts } from "./bdf.js";

export const FONT_DIR = join(ROOT_DIR, "fonts");

interface FontSource {
  repo: string;
  asset: RegExp;
  file: string;
}

// Larger text is drawn by integer-scaling the 12px glyphs, which keeps the pixel grid crisp.
// Ark Pixel is the primary style; Fusion Pixel (same author, ~37 MB zip) fills its missing CJK glyphs.
const ARK: FontSource = {
  repo: "TakWolf/ark-pixel-font",
  asset: /^ark-pixel-font-12px-proportional-bdf-v.*\.zip$/,
  file: "ark-pixel-12px-proportional-zh_hans.bdf",
};
const FUSION: FontSource = {
  repo: "TakWolf/fusion-pixel-font",
  asset: /^fusion-pixel-font-12px-proportional-bdf-v.*\.zip$/,
  file: "fusion-pixel-12px-proportional-zh_hans.bdf",
};

async function download(src: FontSource): Promise<void> {
  const target = join(FONT_DIR, src.file);
  if (existsSync(target)) return;
  const release = (await (await fetch(`https://api.github.com/repos/${src.repo}/releases/latest`)).json()) as {
    assets: { name: string; browser_download_url: string }[];
  };
  const asset = release.assets.find((a) => src.asset.test(a.name));
  if (!asset) throw new Error(`${src.asset} not found in ${src.repo} latest release`);
  console.log(`Downloading ${asset.name}...`);
  const zip = new Uint8Array(await (await fetch(asset.browser_download_url)).arrayBuffer());
  const files = unzipSync(zip, { filter: (f) => f.name.endsWith("zh_hans.bdf") || f.name === "OFL.txt" });
  const bdf = Object.entries(files).find(([name]) => name.endsWith("zh_hans.bdf"));
  if (!bdf) throw new Error(`zh_hans BDF not found in ${asset.name}`);
  mkdirSync(FONT_DIR, { recursive: true });
  writeFileSync(target, bdf[1]);
  if (files["OFL.txt"]) writeFileSync(join(FONT_DIR, "OFL.txt"), files["OFL.txt"]);
}

export async function ensureFonts(withFallback: boolean): Promise<void> {
  await download(ARK);
  if (withFallback) await download(FUSION);
}

export function loadFont(): BdfFont {
  const primary = loadBdf(join(FONT_DIR, ARK.file));
  const fallback = join(FONT_DIR, FUSION.file);
  if (!existsSync(fallback)) {
    console.warn("Fusion Pixel fallback font missing, some CJK glyphs may render as '?'. Run `npm run fonts`.");
    return primary;
  }
  return mergeFonts(primary, loadBdf(fallback));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await ensureFonts(true);
  console.log(`Fonts ready in ${FONT_DIR}`);
}
