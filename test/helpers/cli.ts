import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns the built CLI with a clean environment: no inherited config, a throwaway cache root. */
export function runCli(args: string[], options: { stdin?: string } = {}): Promise<CliRun> {
  const cacheRoot = mkdtempSync(join(tmpdir(), "okf-catalog-test-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    XDG_CACHE_HOME: cacheRoot,
    NODE_LLAMA_CPP_SKIP_DOWNLOAD: "1",
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), "dist", "cli.js"), ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (options.stdin !== undefined) child.stdin.write(options.stdin);
    child.stdin.end();
  });
}
