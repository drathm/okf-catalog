import { type ChildProcess, spawn } from "node:child_process";
import { escapeControls } from "../catalog/text.js";
import { LOG_VALUE_CAP } from "../log.js";

/** Variables git may inherit from the person's session; everything else is withheld (D47). */
const KEEP = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
] as const;

/** Settings every command carries: no hooks, no monitor, no submodules, no maintenance, no prompts, no credentials in URLs, objects checked. */
export const GIT_FIXED_CONFIG: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "submodule.recurse=false",
  "maintenance.auto=false",
  "gc.auto=0",
  "protocol.allow=never",
  "credential.interactive=false",
  "transfer.credentialsInUrl=die",
  "fetch.fsckObjects=true",
];

const STDERR_RAW_CAP = 64 * 1024;
const DEFAULT_STDOUT_CAP = 16 * 1024 * 1024;
const TERM_GRACE_MS = 1000;

/** The environment git runs with: the keep list, copied when set, and the fixed settings. */
export function gitEnvironment(
  source: NodeJS.ProcessEnv,
  allowProtocols: string,
  cacheRoot: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of KEEP) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ALLOW_PROTOCOL = allowProtocols;
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_CEILING_DIRECTORIES = cacheRoot;
  return env;
}

/** URL userinfo replaced by `***`; the scp-like `user@host:path` form carries no password and stays. */
export const redactCredentials = (text: string): string =>
  text.replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s/@]+@/gi, "$1://***@");

export class GitError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly overflow: boolean;
  constructor(
    message: string,
    details: {
      code?: number | null;
      stderr?: string;
      timedOut?: boolean;
      aborted?: boolean;
      overflow?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "GitError";
    this.code = details.code ?? null;
    this.stderr = details.stderr ?? "";
    this.timedOut = details.timedOut ?? false;
    this.aborted = details.aborted ?? false;
    this.overflow = details.overflow ?? false;
  }
}

export interface RunOptions {
  cwd: string;
  /** Passed as `--git-dir=` once the clone exists, so git never searches for a repository. */
  gitDir?: string;
  timeoutMs: number;
  /** Written to the command's stdin, then closed. */
  input?: string;
  /** Receives stdout as it arrives; answering `stop` ends the command, and `stdout` is then empty. */
  onStdout?: (chunk: Buffer) => "continue" | "stop";
  /** The most stdout kept when no consumer streams it. */
  maxStdoutBytes?: number;
  /** Extra `-c key=value` settings for this call only. */
  extraConfig?: readonly string[];
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
  /** The consumer stopped the command before it finished. */
  stopped: boolean;
}

export interface GitRunner {
  run(args: readonly string[], options: RunOptions): Promise<RunResult>;
  /** Kills every running command, with its whole process group, and refuses every command after it. */
  abort(): void;
  readonly running: number;
  /** The environment every command runs with, for callers that must know what git will see. */
  readonly env: NodeJS.ProcessEnv;
}

export interface RunnerOptions {
  /** An absolute path to git; never read from the environment. */
  binary: string;
  /** The `GIT_ALLOW_PROTOCOL` value: `https:ssh` in production, with `file` added by tests. */
  allowProtocols: string;
  cacheRoot: string;
  env: NodeJS.ProcessEnv;
}

/** Captured stderr as it may be logged or shown: redacted, escaped, cut. */
const presentStderr = (raw: Buffer[]): string => {
  const text = Buffer.concat(raw).toString("utf8");
  const safe = escapeControls(redactCredentials(text));
  return safe.length <= LOG_VALUE_CAP ? safe : `${safe.slice(0, LOG_VALUE_CAP)}…`;
};

const killGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
};

/**
 * Runs git as a transport, nothing more: a fixed binary, a built environment, the fixed settings, an explicit
 * repository, its own process group (so a timeout or a shutdown ends ssh and every other child with it),
 * streamed and capped output, and errors that carry no credential.
 */
export function createGitRunner(options: RunnerOptions): GitRunner {
  const env = gitEnvironment(options.env, options.allowProtocols, options.cacheRoot);
  const live = new Set<ChildProcess>();
  let closed = false;
  const configArgs = (extra: readonly string[] = []): string[] =>
    [...GIT_FIXED_CONFIG, ...extra].flatMap((pair) => ["-c", pair]);

  function run(args: readonly string[], run: RunOptions): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      if (closed) {
        reject(new GitError("git was aborted by shutdown", { aborted: true }));
        return;
      }
      const argv = [
        ...configArgs(run.extraConfig),
        ...(run.gitDir === undefined ? [] : [`--git-dir=${run.gitDir}`]),
        ...args,
      ];
      const child = spawn(options.binary, argv, {
        cwd: run.cwd,
        env,
        detached: true,
        stdio: [run.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      live.add(child);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let settled = false;
      let stopped = false;
      let timedOut = false;
      let aborted = false;
      let overflow = false;
      let killTimer: NodeJS.Timeout | undefined;
      const cap = run.maxStdoutBytes ?? DEFAULT_STDOUT_CAP;
      const end = (): void => {
        if (!settled) return;
        clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        live.delete(child);
      };
      const terminate = (): void => {
        killGroup(child, "SIGTERM");
        killTimer = setTimeout(() => killGroup(child, "SIGKILL"), TERM_GRACE_MS);
        killTimer.unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, run.timeoutMs);
      (child as ChildProcess & { okfAbort?: () => void }).okfAbort = () => {
        aborted = true;
        terminate();
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stopped || overflow) return;
        if (run.onStdout !== undefined) {
          if (run.onStdout(chunk) === "stop") {
            stopped = true;
            terminate();
          }
          return;
        }
        outBytes += chunk.length;
        if (outBytes > cap) {
          overflow = true;
          terminate();
          return;
        }
        out.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (errBytes >= STDERR_RAW_CAP) return;
        errBytes += chunk.length;
        err.push(chunk);
      });
      child.on("error", (error) => {
        settled = true;
        end();
        reject(new GitError(`git could not be run: ${redactCredentials(error.message)}`));
      });
      child.on("close", (code) => {
        settled = true;
        end();
        const stderr = presentStderr(err);
        if (aborted) reject(new GitError("git was aborted by shutdown", { stderr, aborted: true }));
        else if (timedOut)
          reject(
            new GitError(`git did not finish within ${run.timeoutMs} ms`, {
              stderr,
              timedOut: true,
            }),
          );
        else if (overflow)
          reject(new GitError(`git printed more than ${cap} bytes`, { stderr, overflow: true }));
        else if (stopped) resolve({ stdout: Buffer.alloc(0), stderr, code, stopped: true });
        else if (code !== 0)
          reject(new GitError(`git exited with ${code}: ${stderr}`, { code, stderr }));
        else resolve({ stdout: Buffer.concat(out), stderr, code, stopped: false });
      });
      if (run.input !== undefined) child.stdin?.end(run.input);
    });
  }

  return {
    run,
    abort: () => {
      // Once aborted, no command starts again: a shutdown must not race a tick into a fresh fetch.
      closed = true;
      for (const child of live) (child as ChildProcess & { okfAbort?: () => void }).okfAbort?.();
    },
    get running() {
      return live.size;
    },
    env,
  };
}
