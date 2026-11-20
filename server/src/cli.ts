import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { config } from "./config.js";
import { parseLocalDate, WEATHER_KINDS, type CalendarContext, type WeatherKind, weatherOverride } from "./calendar/context.js";
import { ensureFonts, loadFont } from "./calendar/fonts.js";
import { buildGallery } from "./calendar/gallery.js";
import { DITHERS, type Dither } from "./calendar/pixelate.js";
import { generate, type GenerateOptions } from "./calendar/pipeline.js";
import { SceneRenderer } from "./calendar/render/runner.js";

const BATCH_PRESETS: { name: string; date: string; weather: WeatherKind; temp?: number }[] = [
  { name: "winter-solstice-snow", date: "2026-12-22T19:30", weather: "snow", temp: -3 },
  { name: "new-years-eve", date: "2027-02-05T22:00", weather: "clear", temp: 2 },
  { name: "summer-thunder", date: "2027-07-15T15:10", weather: "thunder", temp: 31 },
  { name: "friday-rain", date: "2026-11-20T14:25", weather: "rain", temp: 12 },
  { name: "late-night-clear", date: "2026-11-19T01:40", weather: "clear", temp: 6 },
];

const COMMANDS = ["generate", "batch", "recompose", "gallery"];

const USAGE = `Usage:
  npm run generate  -- [--date YYYY-MM-DDTHH:mm] [--weather ${WEATHER_KINDS.join("|")}] [--temp=N]
                       [--dither ${DITHERS.join("|")}] [--scale 1|2|3] [--seed N] [--no-llm] [--name label]
  npm run batch     -- [--dither ...] [--scale ...] [--no-llm] [--concurrency N]
  npm run recompose -- [out-dir ...] [--dither ...] [--scale ...]
                       Re-render saved scene.js + ticker without calling the LLM
                       (no dirs = every non-fallback output).
  npm run gallery`;

interface SavedMeta {
  name: string;
  source: string;
  model: string | null;
  seed: number;
  sceneTitle: string;
  ticker: string[];
  context: CalendarContext;
}

function recomposeJobs(dirs: string[], base: Omit<GenerateOptions, "name" | "date">): GenerateOptions[] {
  const root = config.calendar.outputDir;
  const targets = dirs.length
    ? dirs.map((d) => (isAbsolute(d) || existsSync(d) ? d : join(root, d)))
    : readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(root, d.name))
        .filter((d) => {
          const meta = join(d, "meta.json");
          return existsSync(meta) && JSON.parse(readFileSync(meta, "utf8")).source !== "fallback";
        });
  return targets.map((dir) => {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as SavedMeta;
    return {
      ...base,
      name: meta.name,
      date: parseLocalDate(meta.context.iso),
      weather: meta.context.weather,
      seed: meta.seed,
      model: meta.model,
      reply: {
        scene_title: meta.sceneTitle,
        ticker: meta.ticker,
        scene_js: readFileSync(join(dir, "scene.js"), "utf8"),
      },
    };
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      date: { type: "string" },
      weather: { type: "string" },
      temp: { type: "string" },
      dither: { type: "string", default: "atkinson" },
      scale: { type: "string", default: "2" },
      seed: { type: "string" },
      name: { type: "string" },
      "no-llm": { type: "boolean", default: false },
      concurrency: { type: "string", default: "3" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command || !COMMANDS.includes(command)) {
    console.log(USAGE);
    return;
  }
  if (command === "gallery") {
    console.log(`Gallery written to ${buildGallery(config.calendar.outputDir)}`);
    return;
  }

  if (!DITHERS.includes(values.dither as Dither)) throw new Error(`Unknown --dither ${values.dither}`);
  if (values.weather && !WEATHER_KINDS.includes(values.weather as WeatherKind))
    throw new Error(`Unknown --weather ${values.weather}`);
  const scale = Number(values.scale);
  if (![1, 2, 3].includes(scale)) throw new Error("--scale must be 1, 2 or 3");

  const base = {
    dither: values.dither as Dither,
    scale,
    useLlm: !values["no-llm"],
    seed: values.seed === undefined ? undefined : Number(values.seed),
  };
  let jobs: GenerateOptions[];
  if (command === "generate")
    jobs = [
      {
        ...base,
        name: values.name ?? (values.date ? "custom" : "now"),
        date: values.date ? parseLocalDate(values.date) : new Date(),
        weather: values.weather
          ? weatherOverride(values.weather as WeatherKind, values.temp ? Number(values.temp) : undefined)
          : undefined,
      },
    ];
  else if (command === "batch")
    jobs = [
      { ...base, name: "now", date: new Date() },
      ...BATCH_PRESETS.map((p) => ({
        ...base,
        name: p.name,
        date: parseLocalDate(p.date),
        weather: weatherOverride(p.weather, p.temp),
      })),
    ];
  else jobs = recomposeJobs(args, base);
  if (jobs.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  await ensureFonts(false);
  const font = loadFont();
  const renderer = await SceneRenderer.launch();
  try {
    const limit = Math.max(1, Number(values.concurrency));
    const failures: string[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, jobs.length) }, async () => {
        while (next < jobs.length) {
          const job = jobs[next++]!;
          try {
            await generate(config, renderer, font, job);
          } catch (err) {
            failures.push(`${job.name}: ${(err as Error).message}`);
          }
        }
      }),
    );
    if (failures.length) {
      console.error(`Failed:\n  ${failures.join("\n  ")}`);
      process.exitCode = 1;
    }
    console.log(`Gallery written to ${buildGallery(config.calendar.outputDir)}`);
  } finally {
    await renderer.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
