import { accessSync, constants, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { RESULT_BUDGET } from "../catalog/outputs.js";
import type { Runtime, ToolOptions } from "../catalog/runtime.js";
import { discoverConfigPath, readNetworkConfig } from "../config/network-config.js";
import { cacheRoot, ensureCache, networkDir } from "../fs/cache-dir.js";
import {
  acquireLock,
  type Lock,
  makePrivateDir,
  processAlive,
  readLockOwner,
  sweepPrivate,
} from "../fs/company-lock.js";
import { createLog, type Level, type Log } from "../log.js";
import { createServerFactory } from "../mcp/server.js";
import { serveOverStdio } from "../mcp/stdio.js";
import { createPoller, type Poller } from "../serve/poller.js";
import { createRuntime, type PrepareResult } from "../serve/runtime.js";
import { createGitSource, type GitSource } from "../source/git.js";
import { createGitRunner, type GitRunner, redactCredentials } from "../source/git-runner.js";
import { createLocalSource } from "../source/local.js";
import type { Source } from "../source/source.js";
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
/** How long a signal waits for in-flight calls before the process ends anyway (the lock dies with it). */
const SHUTDOWN_DEADLINE_MS = 5_000;

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
  // A failure of the real stdout (the client stopped reading: EPIPE) reaches the transport through its own
  // stream, so it is reported, never an unhandled 'error' event that ends the process.
  original.on("error", (error) => protocol.destroy(error));
  type Writer = (chunk: unknown, ...rest: unknown[]) => boolean;
  (original as unknown as { write: Writer }).write = (chunk, ...rest) =>
    (process.stderr.write as unknown as Writer)(chunk, ...rest);
  return protocol;
}

/**
 * The minimum git this server runs (D50): `--end-of-options`, `protocol.allow` and `maintenance.auto` are older.
 * Two of the fixed settings are best effort below newer versions and silently ignored before them:
 * `transfer.credentialsInUrl` (2.37) and `credential.interactive` (2.47); the configuration grammar and the
 * detached process (no terminal) cover what they would.
 */
const MIN_GIT: [number, number] = [2, 30];

/** `git` on PATH, resolved once; never read from a variable of its own. */
async function gitBinary(cacheRoot: string): Promise<string> {
  void cacheRoot;
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    if (folder.length === 0) continue;
    const candidate = resolve(folder, "git");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  throw new Error(
    "git was not found on PATH; install git 2.30 or later to serve a repository source",
  );
}

async function requireGitVersion(runner: GitRunner, cwd: string): Promise<void> {
  const result = await runner.run(["--version"], { cwd, timeoutMs: 30_000 });
  const match = /git version (\d+)\.(\d+)/.exec(result.stdout.toString("utf8"));
  const [major, minor] = match === null ? [0, 0] : [Number(match[1]), Number(match[2])];
  if (major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1])) return;
  throw new Error(
    `git ${MIN_GIT[0]}.${MIN_GIT[1]} or later is required to serve a repository source; this is ${match?.[0] ?? "an unknown version"}`,
  );
}

/** Stream failures that mean the client is gone; anything else (a malformed line) is only logged. */
const STREAM_FAILURES = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ECONNRESET", "EIO"]);

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
    status: () => ({ lock: "exclusive", loaded: false, refusing: problem }),
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
    home,
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
  let poller: Poller | undefined;
  let closing: Promise<void> | undefined;
  /** Ends any git in flight and refuses new ones; set once a repository source's runner exists (bite 5 review M2). */
  let abortTransport: () => void = () => undefined;

  if ("error" in found) {
    runtime = refusingRuntime(found.error, log);
  } else {
    // A test-only setting (like OKF_CATALOG_NOW): `file` repositories, for the suite's local bare repositories.
    const fileRepositories = process.env.OKF_CATALOG_GIT_PROTOCOLS === "file";
    const root = cacheRoot({ env: process.env, platform: process.platform, home });
    const read = readNetworkConfig(found.path, home, {
      allowFileRepositories: fileRepositories,
      cacheRoot: root.root,
    });
    if (!read.ok || read.config.bundles.length !== 1) {
      runtime = refusingRuntime(
        `the configuration at ${found.path} is not usable: ${read.ok ? "this build serves one bundle" : read.problems.join("; ")}`,
        log,
      );
    } else {
      const network = read.config;
      const config = network.bundles[0] as (typeof network.bundles)[number];
      const configured = config.source;
      const dir = networkDir(root.root, network.network);
      const described =
        configured.kind === "local"
          ? configured.configured
          : redactCredentials(configured.repository);
      // A repository source is built inside prepare(), once the lock has decided the work folder (D47).
      let gitSource: GitSource | undefined;
      let gitRunner: GitRunner | undefined;
      const placeholder: Source = {
        kind: "git",
        load: async () => {
          throw new Error("the repository source is not prepared");
        },
        describe: () => described,
      };
      const source: Source =
        configured.kind === "local"
          ? createLocalSource(
              { path: configured.path, configured: configured.configured },
              config.caps,
            )
          : placeholder;
      options = {
        company: network.network,
        source: described,
        dev: config.serve.dev,
        limitDefault: network.limitDefault,
        resultBudget: RESULT_BUDGET,
      };
      let lockKind: "exclusive" | "private" = "exclusive";
      const serving = createRuntime({
        company: config.id,
        source,
        prepare: async () => {
          const ensured = ensureCache(dir, root.root, {
            uid: process.getuid?.() ?? 0,
            platform: process.platform,
          });
          if (!ensured.ok) {
            const described = new Error(ensured.problem) as Error & { detail?: string };
            described.detail = ensured.detail;
            throw described;
          }
          sweepPrivate(dir, processAlive);
          let lock: Lock;
          try {
            lock = lockHandle ?? acquireLock(dir, clock());
          } catch (error) {
            // A lock database that cannot be opened: the fix is named, SQLite's words and the path go to the log.
            const described = new Error(
              "the company lock database in the cache folder is unusable; remove it and start again (the log names it)",
            ) as Error & { detail?: string };
            described.detail = `${join(dir, "lock.sqlite")}: ${(error as Error).message}`;
            throw described;
          }
          let work = dir;
          if (lock.kind === "exclusive") lockHandle = lock;
          else {
            work = makePrivateDir(dir, process.pid);
            privateWork = work;
            lockKind = "private";
          }
          let result: PrepareResult;
          // Imported here, after stdout is reserved, so nothing the engine's modules do at load can reach the channel.
          const { QmdEngine } = await import("../engine/qmd.js");
          const engine = await QmdEngine.open({ bundles: [config.id], dir: work });
          if (engine.resetOnOpen !== undefined)
            log.warn("engine.reset", { detail: engine.resetOnOpen });
          result = {
            engine,
            lock: lockKind,
            ...(engine.resetOnOpen === undefined ? {} : { resetOnOpen: engine.resetOnOpen }),
          };
          if (configured.kind === "git") {
            try {
              await prepareGit();
            } catch (error) {
              await engine.close().catch(() => undefined);
              throw error;
            }
          }
          return result;
          async function prepareGit(): Promise<void> {
            if (configured.kind !== "git") return;
            const binary = await gitBinary(root.root);
            gitRunner?.abort();
            const runner = createGitRunner({
              binary,
              allowProtocols: `https:ssh${process.env.OKF_CATALOG_GIT_PROTOCOLS === "file" ? ":file" : ""}`,
              cacheRoot: root.root,
              env: process.env,
            });
            gitRunner = runner;
            await requireGitVersion(runner, work);
            gitSource = createGitSource({
              repository: configured.repository,
              branch: configured.branch,
              bundlePath: configured.bundlePath,
              workDir: join(work, "source"),
              caps: config.caps,
              runner,
              clock,
              log,
            });
            result = { ...result, source: gitSource };
          }
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
        extra: () => ({
          lockOwner: lockKind === "private" ? (readLockOwner(dir) ?? null) : null,
          poller:
            poller?.state() ??
            (configured.kind === "git" ? { intervalMs: config.serve.pullIntervalMs } : null),
        }),
      });
      // The poller starts once the first load has run, whatever its outcome, and ticks at once when the load
      // answered from the tree on disk; it never starts before the handshake, since start() runs on it.
      let pollerStarted = false;
      const startPoller = (): void => {
        if (pollerStarted || configured.kind !== "git") return;
        pollerStarted = true;
        // The poller exists once the first load settles, whatever its outcome, with the source resolved lazily,
        // so a failed prepare() (git missing, the cache unusable) is retried by its ticks (bite 5 review M4).
        void serving
          .ready()
          .catch(() => undefined)
          .then(() => {
            if (closing !== undefined) return;
            poller = createPoller({
              runtime: serving,
              source: () => gitSource,
              intervalMs: config.serve.pullIntervalMs,
              log,
              clock,
              immediate: gitSource?.startedFromDisk() ?? false,
            });
            poller.start();
          });
      };
      abortTransport = () => gitRunner?.abort();
      runtime = {
        ...serving,
        start: () => {
          serving.start();
          startPoller();
        },
      };
      log.info("serve.start", {
        company: network.network,
        source: described,
        dev: config.serve.dev,
        node: process.versions.node,
        configRule: found.rule,
        ...(root.note === undefined ? {} : { note: root.note }),
      });
    }
  }

  const factory = createServerFactory(runtime, options, clock, log, version());
  let onTransportFailure: (error: Error) => void = () => undefined;
  const handle = serveOverStdio(
    factory,
    { stdin: process.stdin, stdout: protocolOut },
    (error) => {
      log.error("transport.error", { error: error.message });
      onTransportFailure(error);
    },
    () => runtime.start?.(),
  );

  let finished: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let signals = 0;
  const cleanup = (): void => {
    lockHandle?.close();
    if (privateWork !== undefined) rmSync(privateWork, { recursive: true, force: true });
  };
  const shutdown = (reason: string): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = (async () => {
      log.info("serve.shutdown", { reason });
      try {
        await poller?.stop();
        abortTransport();
        await runtime.shutdown();
      } catch (error) {
        log.error("transport.error", { error: (error as Error).message });
      }
      cleanup();
      await handle.close().catch(() => undefined);
      finished?.();
    })();
    return closing;
  };
  /** A signal ends the process: the drain gets a deadline, and a second signal ends it at once. */
  /** A shutdown with a deadline: the drain gets its time, then the process ends anyway, git included. */
  const shutdownAndExit = (reason: string): void => {
    const deadline = setTimeout(() => {
      log.error("serve.shutdown", { reason: `${reason}: the drain did not finish in time` });
      abortTransport();
      cleanup();
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    void shutdown(reason).then(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  };
  const onSignal = (signal: string): void => {
    signals += 1;
    if (signals > 1) {
      abortTransport();
      cleanup();
      process.exit(130);
    }
    shutdownAndExit(signal);
  };
  onTransportFailure = (error) => {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (STREAM_FAILURES.has(code)) {
      void shutdown(`the client stopped reading (${code})`).then(() => process.exit(0));
    }
  };
  process.stdin.on("end", () => shutdownAndExit("stdin ended"));
  process.stdin.on("close", () => shutdownAndExit("stdin closed"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => onSignal(signal));
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
