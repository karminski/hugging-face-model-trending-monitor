import { getTrendingResponse, type KvStore } from "./trending";

export interface Env {
  TRENDING_KV: KVNamespace;
}

function adaptKv(namespace: KVNamespace): KvStore {
  return {
    get: (key) => namespace.get(key),
    put: (key, value) => namespace.put(key, value),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/trending.tsv") {
      return getTrendingResponse({
        kv: adaptKv(env.TRENDING_KV),
        now: Date.now(),
      });
    }
    return new Response("not_found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
