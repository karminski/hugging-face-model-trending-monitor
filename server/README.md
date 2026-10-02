# Hugging Face Trending API

Cloudflare Worker that serves the current Hugging Face model trending Top 10 as compact TSV. It stores the previous successful Top 10 in Workers KV and calculates rank movement once per hour.

## Endpoint

`GET /api/trending.tsv`

```text
v1<TAB>fetched_at<TAB>previous_fetched_at<TAB>OK|STALE
rank<TAB>previous_rank<TAB>movement<TAB>rank_delta<TAB>model_id<TAB>pipeline<TAB>parameters<TAB>updated_at<TAB>downloads<TAB>likes
```

`movement` is `UP`, `DN`, `SAME`, or `NEW`. A model moving from rank 6 to rank 1 has `previous_rank=6` and `rank_delta=5`. `NEW` leaves both rank fields empty. Snapshot times and each model's `updated_at` are returned as UTC+8, for example `2026-09-30T10:00:00+08:00`. Upstream failures return the last successful snapshot with status `STALE`; the first failure returns HTTP 502.

`GET /healthz` returns `ok`.

## Free-plan fit

The Worker refreshes on the first request after 3600 seconds, so normal use writes KV about 24 times per day. The Workers Free plan includes 100,000 requests/day, 100,000 KV reads/day, and 1,000 KV writes/day. See [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).

## Develop

```powershell
npm install
npm test
npm run test:live
npm run dev
```

The deployed Worker is [https://hf-trending.karminski.workers.dev](https://hf-trending.karminski.workers.dev). `GET /api/trending.tsv` is the device endpoint.

To deploy again, set `CLOUDFLARE_API_TOKEN` and run:

```powershell
npx wrangler deploy
```

The upstream source is the [Hugging Face Hub models API](https://huggingface.co/docs/huggingface_hub/package_reference/hf_api), sorted by `trendingScore`. `npm run test:live` requests that endpoint. If `huggingface.co` cannot be reached from the local network, the live test retries the same path on `https://hf-mirror.com`. The deployed Worker still calls `huggingface.co`, which is reachable from Cloudflare.
