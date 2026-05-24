#!/usr/bin/env node
import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const args = process.argv.slice(2);
if (args[0] === "--") {
  args.shift();
}

const child = spawn(
  command,
  ["--dir", "packages/cli", "exec", "tsx", "src/index.ts", ...args],
  { stdio: "inherit", shell: process.platform === "win32" },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
