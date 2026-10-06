import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");

/** Spawns the built CLI with a clean environment and a throwaway cache root that is removed afterwards. */
export async function runCli(
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<CliRun> {
  const cacheRoot = mkdtempSync(join(tmpdir(), "okf-catalog-test-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TZ: process.env.TZ ?? "UTC",
    XDG_CACHE_HOME: cacheRoot,
    NODE_LLAMA_CPP_SKIP_DOWNLOAD: "1",
    ...options.env,
  };
  try {
    return await new Promise<CliRun>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], {
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
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}
