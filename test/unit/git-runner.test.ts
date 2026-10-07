import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitRunner,
  GitError,
  gitEnvironment,
  redactCredentials,
} from "../../src/source/git-runner.js";

interface Control {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  sleepMs?: number;
  childMarker?: string;
}

/** A stand-in git: records every call's arguments, environment and working folder, then behaves as told. */
function standIn(dir: string, control: Control): string {
  writeFileSync(join(dir, "control.json"), JSON.stringify(control));
  const script = join(dir, "git");
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const dir = ${JSON.stringify(dir)};
const control = JSON.parse(readFileSync(dir + "/control.json", "utf8"));
appendFileSync(dir + "/calls.jsonl", JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }) + "\\n");
let stdin = "";
if (process.argv.includes("--read-stdin")) { for await (const chunk of process.stdin) stdin += chunk; }
if (control.stdout) process.stdout.write(control.stdout.replace("{stdin}", stdin));
if (control.stderr) process.stderr.write(control.stderr);
if (control.childMarker) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", control.childMarker], { stdio: "ignore" });
  await new Promise((r) => child.on("exit", r));
} else if (control.sleepMs) await new Promise((r) => setTimeout(r, control.sleepMs));
process.exit(control.exitCode ?? 0);
`,
  );
  chmodSync(script, 0o755);
  return script;
}
const calls = (dir: string) =>
  readFileSync(join(dir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string>; cwd: string });
/** Whether a process with the marker runs; pgrep's exit 1 means none, anything else is a broken probe. */
const alive = (marker: string): boolean => {
  const probe = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
  if (probe.status === 0) return probe.stdout.trim().length > 0;
  if (probe.status === 1) return false;
  throw new Error(`pgrep failed: ${probe.error?.message ?? probe.stderr}`);
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
const work = (): string => {
  const d = mkdtempSync(join(tmpdir(), "okf-catalog-git-runner-"));
  dirs.push(d);
  return d;
};
const runner = (binary: string, extra: Partial<Parameters<typeof createGitRunner>[0]> = {}) =>
  createGitRunner({
    binary,
    allowProtocols: "https:ssh:file",
    cacheRoot: "/cache/root",
    env: { ...process.env, PATH: process.env.PATH ?? "" },
    ...extra,
  });

describe("gitEnvironment", () => {
  it("is built from the keep list and the fixed settings, never from the rest of the environment", () => {
    const env = gitEnvironment(
      {
        HOME: "/home/me",
        PATH: "/usr/bin",
        LANG: "C.UTF-8",
        SSH_AUTH_SOCK: "/tmp/agent",
        GIT_SSH_COMMAND: "ssh -i key",
        HTTPS_PROXY: "http://proxy:3128",
        all_proxy: "socks5://proxy:1080",
        no_proxy: "localhost",
        XDG_CONFIG_HOME: "/home/me/.config",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
        GIT_DIR: "/evil/.git",
        GIT_CONFIG_GLOBAL: "/evil/gitconfig",
        GIT_EXEC_PATH: "/evil/exec",
        GIT_SSL_NO_VERIFY: "1",
        GIT_TRACE: "/evil/trace",
        GIT_ASKPASS: "/evil/askpass",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.sshCommand",
        LD_PRELOAD: "/evil.so",
        DYLD_INSERT_LIBRARIES: "/evil.dylib",
        SOMETHING_ELSE: "x",
      },
      "https:ssh",
      "/cache/root",
    );
    expect(env).toEqual({
      HOME: "/home/me",
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      SSH_AUTH_SOCK: "/tmp/agent",
      GIT_SSH_COMMAND: "ssh -i key",
      HTTPS_PROXY: "http://proxy:3128",
      all_proxy: "socks5://proxy:1080",
      no_proxy: "localhost",
      XDG_CONFIG_HOME: "/home/me/.config",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "https:ssh",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: "/cache/root",
    });
  });
});

describe("redactCredentials", () => {
  it("replaces URL userinfo and leaves the scp-like user@host form alone", () => {
    expect(
      redactCredentials(
        "fatal: https://alice:s3cret@host/x and ssh://bob@h/y and git@host:o/r.git",
      ),
    ).toBe("fatal: https://***@host/x and ssh://***@h/y and git@host:o/r.git");
  });
});

describe("createGitRunner", () => {
  it("runs the binary with the fixed options, an explicit git dir, the arguments in order and the built environment", async () => {
    const dir = work();
    const git = runner(standIn(dir, { stdout: "ok\n" }), {
      env: { ...process.env, GIT_DIR: "/evil/.git", GIT_TRACE: "1", SSH_AUTH_SOCK: "/tmp/sock" },
    });
    const result = await git.run(
      ["fetch", "--depth=1", "--", "origin", "+refs/heads/x:refs/remotes/origin/x"],
      {
        cwd: dir,
        gitDir: join(dir, "repo.git"),
        timeoutMs: 5000,
      },
    );
    expect(result.stdout.toString()).toBe("ok\n");
    expect(result.code).toBe(0);
    const [call] = calls(dir);
    expect(call?.argv.slice(0, 2)).toEqual(["-c", "core.hooksPath=/dev/null"]);
    expect(call?.argv).toContain("protocol.allow=never");
    expect(call?.argv).toContain("credential.interactive=false");
    expect(call?.argv).toContain("transfer.credentialsInUrl=die");
    expect(call?.argv).toContain("fetch.fsckObjects=true");
    const gitDirAt = call?.argv.indexOf(`--git-dir=${join(dir, "repo.git")}`) ?? -1;
    expect(gitDirAt).toBeGreaterThan(0);
    expect(call?.argv.slice(gitDirAt + 1)).toEqual([
      "fetch",
      "--depth=1",
      "--",
      "origin",
      "+refs/heads/x:refs/remotes/origin/x",
    ]);
    expect(call?.env.GIT_DIR).toBeUndefined();
    expect(call?.env.GIT_TRACE).toBeUndefined();
    expect(call?.env.SSH_AUTH_SOCK).toBe("/tmp/sock");
    expect(call?.env.GIT_ALLOW_PROTOCOL).toBe("https:ssh:file");
    expect(call?.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(git.env.GIT_ALLOW_PROTOCOL).toBe("https:ssh:file");
    expect(git.env.GIT_DIR).toBeUndefined();
    expect(realpathSync(call?.cwd ?? "")).toBe(realpathSync(dir));
  });

  it("feeds the input to stdin and passes per-call configuration", async () => {
    const dir = work();
    const git = runner(standIn(dir, { stdout: "got:{stdin}" }));
    const result = await git.run(["cat-file", "--batch", "--read-stdin"], {
      cwd: dir,
      timeoutMs: 5000,
      input: "abc\ndef\n",
      extraConfig: ["core.sshCommand=ssh -o BatchMode=yes"],
    });
    expect(result.stdout.toString()).toBe("got:abc\ndef\n");
    expect(calls(dir)[0]?.argv).toContain("core.sshCommand=ssh -o BatchMode=yes");
  });

  it("kills the whole process group on timeout and reports it", async () => {
    const dir = work();
    const marker = `okfmarker${process.pid}${Date.now()}`;
    const git = runner(standIn(dir, { childMarker: marker }));
    const started = Date.now();
    await expect(git.run(["fetch"], { cwd: dir, timeoutMs: 400 })).rejects.toMatchObject({
      timedOut: true,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(marker)).toBe(false);
  });

  it("stops the command when the consumer says so, and refuses output over the cap otherwise", async () => {
    const dir = work();
    const git = runner(standIn(dir, { stdout: "x".repeat(300_000), sleepMs: 2000 }));
    let chunks = 0;
    const stopped = await git.run(["ls-tree"], {
      cwd: dir,
      timeoutMs: 5000,
      onStdout: () => {
        chunks += 1;
        return "stop";
      },
    });
    expect(stopped.stopped).toBe(true);
    expect(chunks).toBe(1);
    await expect(
      git.run(["ls-tree"], { cwd: dir, timeoutMs: 5000, maxStdoutBytes: 1000 }),
    ).rejects.toMatchObject({
      overflow: true,
    });
  });

  it("reports a failing command with its stderr escaped, capped and credentials replaced", async () => {
    const dir = work();
    const git = runner(
      standIn(dir, {
        exitCode: 128,
        stderr: `fatal: https://alice:s3cret@host/x\u001b[2K\n${"y".repeat(5000)}`,
      }),
    );
    const error = await git.run(["fetch"], { cwd: dir, timeoutMs: 5000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    const git128 = error as GitError;
    expect(git128.code).toBe(128);
    expect(git128.stderr).toContain("https://***@host/x");
    expect(git128.stderr).not.toContain("\u001b");
    expect(git128.stderr.length).toBeLessThanOrEqual(2100);
    expect(git128.message).not.toContain("s3cret");
  });

  it("abort() kills every running command", async () => {
    const dir = work();
    const marker = `okfabort${process.pid}${Date.now()}`;
    const git = runner(standIn(dir, { childMarker: marker }));
    const pending = git.run(["fetch"], { cwd: dir, timeoutMs: 30_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(git.running).toBe(1);
    git.abort();
    await expect(pending).rejects.toMatchObject({ aborted: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(marker)).toBe(false);
    expect(git.running).toBe(0);
  });
});
