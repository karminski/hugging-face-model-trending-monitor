import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KvStore } from "./trending.js";

/** Workers KV stand-in: each key is stored as `<dir>/<key>.json`. */
export class FileKv implements KvStore {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    if (!/^[\w.-]+$/.test(key)) throw new Error(`Invalid KV key: ${key}`);
    return join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<string | null> {
    const path = this.path(key);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  async put(key: string, value: string): Promise<void> {
    const path = this.path(key);
    mkdirSync(this.dir, { recursive: true });
    // Write-then-rename so a crash never leaves a half-written snapshot behind.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, value);
    renameSync(tmp, path);
  }
}
