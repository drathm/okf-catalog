import { accessSync, constants, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { RESULT_BUDGET } from "../catalog/outputs.js";
import type { Runtime, ToolOptions } from "../catalog/runtime.js";
import {
  type BundleConfig,
  discoverConfigPath,
  readNetworkConfig,
} from "../config/network-config.js";
import { bundleWorkDir, cacheRoot, ensureCache, networkDir } from "../fs/cache-dir.js";
import {
  acquireLock,
  type Lock,
  makePrivateDir,
  processAlive,
  readLockOwner,
  sweepPrivate,
} from "../fs/company-lock.js";
import { createLog, type Fields, type Level, type Log } from "../log.js";
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

Serves a network of bundles (one, or several) to an MCP client over stdio. stdout carries the protocol and
nothing else; the log is JSON lines on stderr. The bundles are loaded when the first client completes its
handshake.

options:
  --config <path>       the network's configuration, network: and bundles:, or company: and source: for one
                        bundle (else OKF_CATALOG_CONFIG, else ./okf-catalog.yaml)
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

/** The log a bundle's own parts write to: every record names the bundle. */
function forBundle(log: Log, bundle: string): Log {
  const tag = (fields: Fields = {}): Fields => ({ bundle, ...fields });
  return {
    error: (event, fields) => log.error(event, tag(fields)),
    warn: (event, fields) => log.warn(event, tag(fields)),
    info: (event, fields) => log.info(event, tag(fields)),
    debug: (event, fields) => log.debug(event, tag(fields)),
  };
}

/**
 * The clone a version 0 server kept at the root of the network's folder (D73): moved into the one repository
 * bundle's folder when the network has exactly one and that bundle has no clone yet, which keeps its served tree
 * on disk for the offline fallback; removed otherwise, being derived. Only a real folder is moved; a link is
 * removed. Run under the exclusive lock only, never in the private fallback.
 */
function moveVersion0Clone(dir: string, repositories: readonly BundleConfig[], log: Log): void {
  const old = join(dir, "source");
  const stat = lstatSync(old, { throwIfNoEntry: false });
  if (stat === undefined) return;
  const [only] = repositories;
  try {
    if (stat.isDirectory() && only !== undefined && repositories.length === 1) {
      const own = bundleWorkDir(dir, only.id);
      const target = join(own, "source");
      // Anything at the target, a link included, is the bundle's own: the old clone is then only removed.
      if (lstatSync(target, { throwIfNoEntry: false }) === undefined) {
        mkdirSync(own, { recursive: true, mode: 0o700 });
        renameSync(old, target);
        log.info("cache.version0", {
          bundle: only.id,
          detail: "the version 0 clone was moved into the bundle's folder",
        });
        return;
      }
    }
    rmSync(old, { recursive: true, force: true });
  } catch (error) {
    const described = new Error(
      "the version 0 clone in the cache folder could not be moved or removed; the log has the detail",
    ) as Error & { detail?: string };
    described.detail = `${old}: ${(error as Error).message}`;
    throw described;
  }
  log.info("cache.version0", {
    detail: "the version 0 clone was removed: no one repository bundle could take it",
  });
}

function refusingRuntime(problem: string, log: Log): Runtime {
  log.error("serve.refusing", { problem });
  const reject = (): Promise<never> => Promise.reject(new Error(problem));
  return {
    ready: reject,
    lease: reject,
    refresh: reject,
    status: () => ({ lock: "exclusive", loaded: false, refusing: problem, bundles: [] }),
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
    network: "unknown",
    bundles: [],
    limitDefault: 8,
    resultBudget: RESULT_BUDGET,
  };
  let lockHandle: Extract<Lock, { kind: "exclusive" }> | undefined;
  let privateWork: string | undefined;
  /** One poller per repository bundle, each at its own interval (D75). */
  const pollers = new Map<string, Poller>();
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
    if (!read.ok) {
      runtime = refusingRuntime(
        `the configuration at ${found.path} is not usable: ${read.problems.join("; ")}`,
        log,
      );
    } else {
      const network = read.config;
      const dir = networkDir(root.root, network.network);
      const repositories = network.bundles.filter((bundle) => bundle.source.kind === "git");
      /** A bundle's source as the model may see it: the folder as written, or the repository without credentials. */
      const describedOf = (bundle: BundleConfig): string =>
        bundle.source.kind === "local"
          ? bundle.source.configured
          : redactCredentials(bundle.source.repository);
      // Repository sources are built inside prepare(), once the lock has decided the work folder (D47).
      const gitSources = new Map<string, GitSource>();
      let gitRunner: GitRunner | undefined;
      const sourceOf = (bundle: BundleConfig): Source =>
        bundle.source.kind === "local"
          ? createLocalSource(
              { path: bundle.source.path, configured: bundle.source.configured },
              bundle.caps,
            )
          : {
              kind: "git",
              load: async () => {
                throw new Error("the repository source is not prepared");
              },
              describe: () => describedOf(bundle),
            };
      options = {
        network: network.network,
        bundles: network.bundles.map((bundle) => ({
          id: bundle.id,
          source: describedOf(bundle),
          sourceKind: bundle.source.kind,
        })),
        limitDefault: network.limitDefault,
        resultBudget: RESULT_BUDGET,
      };
      let lockKind: "exclusive" | "private" = "exclusive";
      const serving = createRuntime({
        bundles: network.bundles.map((bundle) => ({
          id: bundle.id,
          source: sourceOf(bundle),
          load: {
            admit: bundle.serve.admit,
            dev: bundle.serve.dev,
            integrity: bundle.integrity,
            specText: bundle.specText,
            caps: bundle.caps,
            ...(bundle.types === undefined ? {} : { types: bundle.types }),
          },
        })),
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
              "the network's lock database in the cache folder is unusable; remove it and start again (the log names it)",
            ) as Error & { detail?: string };
            described.detail = `${join(dir, "lock.sqlite")}: ${(error as Error).message}`;
            throw described;
          }
          let work = dir;
          if (lock.kind === "exclusive") {
            lockHandle = lock;
            // Under the exclusive lock only, never in the private fallback (D73): a version 0 clone moves into its
            // bundle's folder; the engine clears the version 0 link and generations at the root when it opens.
            moveVersion0Clone(dir, repositories, log);
          } else {
            work = makePrivateDir(dir, process.pid);
            privateWork = work;
            lockKind = "private";
          }
          let result: PrepareResult;
          // Imported here, after stdout is reserved, so nothing the engine's modules do at load can reach the channel.
          const { QmdEngine } = await import("../engine/qmd.js");
          const engine = await QmdEngine.open({
            bundles: network.bundles.map((bundle) => bundle.id),
            dir: work,
          });
          if (engine.resetOnOpen !== undefined)
            log.warn("engine.reset", { detail: engine.resetOnOpen });
          result = {
            engine,
            lock: lockKind,
            ...(engine.resetOnOpen === undefined ? {} : { resetOnOpen: engine.resetOnOpen }),
          };
          if (repositories.length > 0) {
            try {
              await prepareGit();
            } catch (error) {
              await engine.close().catch(() => undefined);
              throw error;
            }
          }
          return result;
          async function prepareGit(): Promise<void> {
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
            for (const bundle of repositories) {
              if (bundle.source.kind !== "git") continue;
              // Each bundle's clone, fetch state and extracted trees in a folder named by its id (issue 3, D73).
              const own = bundleWorkDir(work, bundle.id);
              mkdirSync(own, { recursive: true, mode: 0o700 });
              gitSources.set(
                bundle.id,
                createGitSource({
                  repository: bundle.source.repository,
                  branch: bundle.source.branch,
                  bundlePath: bundle.source.bundlePath,
                  workDir: join(own, "source"),
                  caps: bundle.caps,
                  runner,
                  clock,
                  log: forBundle(log, bundle.id),
                }),
              );
            }
            result = { ...result, sources: new Map(gitSources) };
          }
        },
        clock,
        log,
        extra: () => ({
          lockOwner: lockKind === "private" ? (readLockOwner(dir) ?? null) : null,
          pollers: Object.fromEntries(
            repositories.map((bundle) => [
              bundle.id,
              pollers.get(bundle.id)?.state() ?? { intervalMs: bundle.serve.pullIntervalMs },
            ]),
          ),
        }),
      });
      // The pollers start once the first load has run, whatever its outcome, each ticking at once when its
      // bundle's load answered from the tree on disk; they never start before the handshake, since start() runs
      // on it.
      let pollersStarted = false;
      const startPollers = (): void => {
        if (pollersStarted || repositories.length === 0) return;
        pollersStarted = true;
        // Each poller exists once the first load settles, whatever its outcome, with its source resolved lazily,
        // so a failed prepare() (git missing, the cache unusable) is retried by its ticks (bite 5 review M4).
        void serving
          .ready()
          .catch(() => undefined)
          .then(() => {
            if (closing !== undefined) return;
            for (const bundle of repositories) {
              const poller = createPoller({
                runtime: serving,
                bundle: bundle.id,
                source: () => gitSources.get(bundle.id),
                intervalMs: bundle.serve.pullIntervalMs,
                log,
                clock,
                immediate: gitSources.get(bundle.id)?.startedFromDisk() ?? false,
              });
              pollers.set(bundle.id, poller);
              poller.start();
            }
          });
      };
      abortTransport = () => gitRunner?.abort();
      runtime = {
        ...serving,
        start: () => {
          serving.start();
          startPollers();
        },
      };
      log.info("serve.start", {
        network: network.network,
        form: network.form,
        bundles: network.bundles.map((bundle) => bundle.id),
        node: process.versions.node,
        configRule: found.rule,
        ...(root.note === undefined ? {} : { note: root.note }),
      });
      if (network.form === "company") {
        log.warn("serve.alias", {
          detail:
            "company: is read as a network of that name with one bundle of that id; write network: and bundles: before 0.5.0, which removes company:",
        });
      }
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
        for (const poller of pollers.values()) await poller.stop();
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
