import { spawn } from "node:child_process";

const child = spawn("npx", ["vitest", "run"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, LIVE: "1" },
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
