import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI = join(REPO, "dist", "cli.js");
export const NOW_ISO = "2026-10-06T12:00:00Z";

export interface Sandbox {
  root: string;
  cacheRoot: string;
  cwd: string;
  configPath: string;
  env: Record<string, string>;
  dispose(): void;
}

/** A sandbox for one spawned server: its own cache root, working folder and configuration pointing at a fixture. */
export function sandbox(fixture: string, configYaml?: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "okf-catalog-stdio-"));
  const cacheRoot = join(root, "cache");
  const cwd = join(root, "cwd");
  mkdirSync(cacheRoot);
  mkdirSync(cwd);
  const configPath = join(root, "okf-catalog.yaml");
  writeFileSync(
    configPath,
    configYaml ??
      `company: fixture\nsource:\n  local: ${join(REPO, "test", "fixtures", "bundles", fixture)}\n`,
  );
  const env: Record<string, string> = {
    ...(getDefaultEnvironment() as Record<string, string>),
    XDG_CACHE_HOME: cacheRoot,
    TZ: "UTC",
    OKF_CATALOG_NOW: NOW_ISO,
    NODE_LLAMA_CPP_SKIP_DOWNLOAD: "1",
  };
  return {
    root,
    cacheRoot,
    cwd,
    configPath,
    env,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface RawRun {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  send(message: object): void;
  /** Waits until a stdout line holds a response with this id, or the timeout passes. */
  waitFor(id: number, ms?: number): Promise<Record<string, unknown>>;
  /** Closes stdin and waits for the process to exit. */
  end(ms?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Waits for the process to exit on its own; reports a timeout without touching it. */
  waitExit(
    ms?: number,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>;
}

/** Spawns the server as a raw child and speaks newline-delimited JSON-RPC to it, keeping every byte of both streams. */
export function rawServer(box: Sandbox, extraArgs: string[] = [], nodeArgs: string[] = []): RawRun {
  const child = spawn(
    process.execPath,
    [...nodeArgs, CLI, "serve", "--config", box.configPath, ...extraArgs],
    {
      cwd: box.cwd,
      env: box.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    send: (message) => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    },
    waitFor: (id, ms = 15_000) =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = (): void => {
          for (const line of out.split("\n")) {
            if (line.trim().length === 0) continue;
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (parsed.id === id) {
                resolve(parsed);
                return;
              }
            } catch {
              // a non-JSON line is a purity failure the test asserts on separately
            }
          }
          if (Date.now() - started > ms)
            reject(new Error(`no response ${id} within ${ms} ms; stderr: ${err.slice(-500)}`));
          else setTimeout(tick, 20);
        };
        tick();
      }),
    end: async (ms = 15_000) => {
      child.stdin?.end();
      const timer = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ code: null, signal: "SIGKILL" });
        }, ms),
      );
      return Promise.race([exited, timer]);
    },
    waitExit: (ms = 15_000) =>
      Promise.race([
        exited.then((e) => ({ ...e, timedOut: false })),
        new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>(
          (resolve) => setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), ms),
        ),
      ]),
  };
}

export const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw-test", version: "0.0.0" },
  },
};
export const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

/** Every non-empty stdout line must be a JSON-RPC message; returns the offending lines. */
export function impureLines(stdout: string): string[] {
  const bad: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      if (parsed.jsonrpc !== "2.0") bad.push(line);
    } catch {
      bad.push(line);
    }
  }
  return bad;
}
