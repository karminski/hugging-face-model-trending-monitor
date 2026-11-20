# Pixel Monitor Backend

Local Node service for the ESP32-S3-RLCD-4.2. One process serves two features:

- **HF Trending**: the Hugging Face trending Top 10 as compact TSV for the device, with rank movement against the previous snapshot. Replaces the former Cloudflare Worker with identical output.
- **AI Calendar**: scheduled LLM-generated Three.js scenes, rendered in headless Chromium, dithered to 1-bit and composed into a 400x300 frame with time, weather, solar term and a scrolling ticker.

All runtime settings live in the repository-root `.env` (see [`../.env.example`](../.env.example)).

## Run

```powershell
Copy-Item ..\.env.example ..\.env   # then fill in LLM_API_KEY etc.
npm install
npm run serve
```

Open `http://127.0.0.1:8787/`. Set `HTTP_HOST=0.0.0.0` to reach it from the LAN.

## Endpoints

| Path | Description |
|---|---|
| `GET /healthz` | `ok` |
| `GET /api/trending.tsv` | Device endpoint, format below |
| `GET /trending` | Debug table of the current snapshot |
| `POST /api/trending/refresh` | Fetch from Hugging Face now |
| `GET /calendar/` | Live gallery of generated frames and animations |
| `GET /calendar/latest/<file>` | Newest output, e.g. `frame.png`, `frame.bin`, `anim.gif`, `animation/scene-00.bin` |
| `POST /api/calendar/generate` | Generate a frame now |
| `GET /api/calendar/device.bin` | Latest calendar as a device bundle with one animated loop per dither (layout in `src/calendar/device.ts`); ETag = output dir, `304` on `If-None-Match` |
| `GET /api/status`, `/api/calendar/status` | JSON status of both schedulers |

## Trending TSV

```text
v1<TAB>fetched_at<TAB>previous_fetched_at<TAB>OK|STALE
rank<TAB>previous_rank<TAB>movement<TAB>rank_delta<TAB>model_id<TAB>pipeline<TAB>parameters<TAB>updated_at<TAB>downloads<TAB>likes
```

`movement` is `UP`, `DN`, `SAME`, or `NEW`. A model moving from rank 6 to rank 1 has `previous_rank=6` and `rank_delta=5`. `NEW` leaves both rank fields empty. Times are UTC+8, for example `2026-09-30T10:00:00+08:00`. Upstream failures return the last successful snapshot with status `STALE`; the first failure returns HTTP 502.

The snapshot is stored in `data/trending-state.json`. It is refreshed every `TRENDING_REFRESH_MIN` minutes, and a request also refreshes it when it is older than that. A manual refresh moves the movement baseline as well.

The upstream is the [Hugging Face Hub models API](https://huggingface.co/docs/huggingface_hub/package_reference/hf_api) sorted by `trendingScore`. `hf-mirror.com` rejects the `expand=` fields this query needs (HTTP 503), so if `huggingface.co` is unreachable, set `HF_PROXY` to an HTTP proxy; it is used for Hugging Face requests only.

## AI Calendar

Each scheduled run (aligned to local midnight, so `CALENDAR_INTERVAL_MIN=60` runs at every full hour) fetches the weather from Open-Meteo, asks the LLM for a ticker and a looping Three.js scene, renders 12 frames, and writes into `data/calendar/<stamp>_auto_<id>/`:

- `frame.png`, `preview@3x.png`, `frame.bin` (400x300, 1bpp, MSB first)
- `anim.gif`, `animation/frame-NN.png`, `animation/scene-NN.bin` (bayer4, 262x288 scene slices)
- `animation/<dither>/frame-NN.png` for every dither; atkinson and floyd keep the first frame's ink wherever luma barely changes, so error diffusion does not shimmer
- `ticker.png`, `ticker.json`, `scene.js`, `meta.json`

Weather requests retry 3 times and fall back to a cached reading up to 3 hours old (`data/cache/weather.json`). Fonts are downloaded to `fonts/` on first use (`npm run fonts` fetches the CJK fallback too).

Offline commands:

```powershell
npm run generate -- [--date YYYY-MM-DDTHH:mm] [--weather clear|rain|snow|...] [--no-llm]
npm run batch
npm run recompose -- [out-dir ...]
npm run gallery
```

## Tests

```powershell
npm test
npm run typecheck
npm run test:live   # also hits the real Hugging Face API
```
