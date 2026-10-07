import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { RESULT_BUDGET } from "../catalog/outputs.js";
import type { Runtime, ToolOptions } from "../catalog/runtime.js";
import { discoverConfigPath, readCompanyConfig } from "../config/company-config.js";
import { cacheRoot, companyDir, ensureCache } from "../fs/cache-dir.js";
import {
  acquireLock,
  type Lock,
  makePrivateDir,
  processAlive,
  sweepPrivate,
} from "../fs/company-lock.js";
import { createLog, type Level, type Log } from "../log.js";
import { createServerFactory } from "../mcp/server.js";
import { serveOverStdio } from "../mcp/stdio.js";
import { createRuntime } from "../serve/runtime.js";
import { createLocalSource } from "../source/local.js";
import { clockFrom } from "./check.js";

export const SERVE_USAGE = `usage: okf-catalog serve [options]

Serves the company's bundle to an MCP client over stdio. stdout carries the protocol and nothing else; the log
is JSON lines on stderr. The bundle is loaded when the first client completes its handshake.

options:
  --config <path>       the company configuration (else OKF_CATALOG_CONFIG, else ./okf-catalog.yaml)
  --log-level <level>   error, warn, info (default) or debug

exit codes: 0 the client closed the connection; 2 usage error or unsupported host
`;

const LEVELS = new Set<Level>(["error", "warn", "info", "debug"]);

/**
 * Reserves stdout for the protocol (decision D36). Returns a stream bound to the original stdout writer for the
 * transport; from here on anything else that writes to `process.stdout` lands on stderr instead.
 */
function reserveStdout(): Writable {
  const original = process.stdout;
  const write = original.write.bind(original);
  const protocol = new Writable({
    write(chunk, encoding, callback) {
      write(chunk, encoding, callback);
    },
  });
  type Writer = (chunk: unknown, ...rest: unknown[]) => boolean;
  (original as unknown as { write: Writer }).write = (chunk, ...rest) =>
    (process.stderr.write as unknown as Writer)(chunk, ...rest);
  return protocol;
}

/** Every console method becomes a log record, so a dependency's message never reaches the protocol channel. */
function redirectConsole(log: Log): void {
  const methods = ["log", "info", "debug", "dir", "table", "trace", "warn", "error"] as const;
  for (const method of methods) {
    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      const text = args
        .map((a) =>
          typeof a === "string"
            ? a
            : ((): string => {
                try {
                  return JSON.stringify(a) ?? String(a);
                } catch {
                  return String(a);
                }
              })(),
        )
        .join(" ");
      if (method === "warn" || method === "error") log.warn("console", { method, text });
      else log.debug("console", { method, text });
    };
  }
}

function refusingRuntime(problem: string, log: Log): Runtime {
  log.error("serve.refusing", { problem });
  const reject = (): Promise<never> => Promise.reject(new Error(problem));
  return {
    ready: reject,
    lease: reject,
    refresh: reject,
    status: () => ({ lock: "exclusive", refusing: problem }),
    shutdown: async () => undefined,
  };
}

function version(): string {
  const require = createRequire(import.meta.url);
  return (require("../../package.json") as { version: string }).version;
}

/** The serve command. Resolves with the exit code once the connection has closed, or at once on a usage error. */
export async function runServe(argv: string[]): Promise<number> {
  const protocolOut = reserveStdout();
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        config: { type: "string" },
        "log-level": { type: "string", default: "info" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${SERVE_USAGE}`);
    return 2;
  }
  const levelFlag = String(parsed.values["log-level"]);
  if (!LEVELS.has(levelFlag as Level)) {
    process.stderr.write(`--log-level must be error, warn, info or debug\n${SERVE_USAGE}`);
    return 2;
  }
  if (process.platform === "win32") {
    process.stderr.write(
      "Windows is not a version 0 host: the cache folder's ownership and mode checks assume POSIX\n",
    );
    return 2;
  }
  const log = createLog(process.stderr, levelFlag as Level);
  redirectConsole(log);
  let clock: () => Date;
  try {
    const fixed = process.env.OKF_CATALOG_NOW;
    if (fixed !== undefined && fixed.length > 0) {
      const at = clockFrom(process.env);
      clock = () => at;
    } else clock = () => new Date();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  const home = homedir();
  const found = discoverConfigPath(
    parsed.values.config === undefined ? undefined : String(parsed.values.config),
    process.env,
    process.cwd(),
  );
  let runtime: Runtime;
  let options: ToolOptions = {
    company: "unknown",
    source: "unknown",
    dev: false,
    limitDefault: 8,
    resultBudget: RESULT_BUDGET,
  };
  let lockHandle: Extract<Lock, { kind: "exclusive" }> | undefined;
  let privateWork: string | undefined;

  if ("error" in found) {
    runtime = refusingRuntime(found.error, log);
  } else {
    const read = readCompanyConfig(found.path, home);
    if (!read.ok) {
      runtime = refusingRuntime(
        `the configuration at ${found.path} is not usable: ${read.problems.join("; ")}`,
        log,
      );
    } else if (read.config.source.kind !== "local") {
      runtime = refusingRuntime(
        "git sources arrive with the next bite; use source.local in the configuration",
        log,
      );
    } else {
      const config = read.config;
      const local = read.config.source;
      const root = cacheRoot({ env: process.env, platform: process.platform, home });
      const dir = companyDir(root.root, config.company);
      const source = createLocalSource(
        { path: local.path, configured: local.configured },
        config.caps,
      );
      options = {
        company: config.company,
        source: local.configured,
        dev: config.serve.dev,
        limitDefault: config.serve.limitDefault,
        resultBudget: RESULT_BUDGET,
      };
      runtime = createRuntime({
        company: config.company,
        source,
        prepare: async () => {
          const ensured = ensureCache(dir, root.root, {
            uid: process.getuid?.() ?? 0,
            platform: process.platform,
          });
          if (!ensured.ok) throw new Error(ensured.problem);
          sweepPrivate(dir, processAlive);
          const lock = acquireLock(dir, clock());
          let work = dir;
          let kind: "exclusive" | "private" = "exclusive";
          if (lock.kind === "exclusive") lockHandle = lock;
          else {
            work = makePrivateDir(dir, process.pid);
            privateWork = work;
            kind = "private";
          }
          // Imported here, after stdout is reserved, so nothing the engine's modules do at load can reach the channel.
          const { QmdEngine } = await import("../engine/qmd.js");
          const engine = await QmdEngine.open({ company: config.company, dir: work });
          if (engine.resetOnOpen !== undefined)
            log.warn("engine.reset", { detail: engine.resetOnOpen });
          return { engine, lock: kind };
        },
        load: {
          admit: config.serve.admit,
          dev: config.serve.dev,
          integrity: config.integrity,
          specText: config.specText,
          caps: config.caps,
          ...(config.types === undefined ? {} : { types: config.types }),
        },
        clock,
        log,
      });
      log.info("serve.start", {
        company: config.company,
        source: local.configured,
        dev: config.serve.dev,
        node: process.versions.node,
        configRule: found.rule,
        ...(root.note === undefined ? {} : { note: root.note }),
      });
    }
  }

  const factory = createServerFactory(runtime, options, clock, log, version());
  const handle = serveOverStdio(factory, { stdin: process.stdin, stdout: protocolOut }, (error) =>
    log.error("transport.error", { error: error.message }),
  );

  let finished: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let closing: Promise<void> | undefined;
  const shutdown = (reason: string): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = (async () => {
      log.info("serve.shutdown", { reason });
      try {
        await runtime.shutdown();
      } catch (error) {
        log.error("transport.error", { error: (error as Error).message });
      }
      lockHandle?.close();
      if (privateWork !== undefined) rmSync(privateWork, { recursive: true, force: true });
      await handle.close().catch(() => undefined);
      finished?.();
    })();
    return closing;
  };
  process.stdin.on("end", () => void shutdown("stdin ended"));
  process.stdin.on("close", () => void shutdown("stdin closed"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
  process.on("exit", () => {
    // Synchronous last resort: a crash must not leave a private copy behind.
    if (privateWork !== undefined) {
      try {
        rmSync(privateWork, { recursive: true, force: true });
      } catch {
        // nothing else to do at exit
      }
    }
  });
  await done;
  return 0;
}
