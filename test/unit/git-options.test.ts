import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The three git options the plan relies on, confirmed against whatever git the machine or the CI runner has.
const work = mkdtempSync(join(tmpdir(), "okf-catalog-git-"));
const remote = join(work, "remote.git");
const identity = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@example.test",
  "-c",
  "commit.gpgsign=false",
];

const git = (args: string[], cwd = work, env: Record<string, string> = {}): string =>
  execFileSync("git", args, {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: work, GIT_TERMINAL_PROMPT: "0", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Clones without checking out, as the plan does, then fetches the branch so FETCH_HEAD can be checked out. */
const cloneNoCheckout = (name: string): string => {
  const clone = join(work, name);
  git(["clone", "-q", "--no-checkout", "--template=", "--", remote, clone]);
  git(
    [
      "fetch",
      "-q",
      "--depth=1",
      "--",
      "origin",
      "+refs/heads/published:refs/remotes/origin/published",
    ],
    clone,
  );
  return clone;
};

beforeAll(() => {
  git(["init", "-q", "--bare", remote]);
  const src = join(work, "src");
  git(["init", "-q", "-b", "published", src]);
  writeFileSync(join(src, "a.md"), "# page\n");
  git([...identity, "add", "a.md"], src);
  git([...identity, "commit", "-q", "-m", "one"], src);
  git(["push", "-q", remote, "published"], src);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("git options the plan relies on", () => {
  it("GIT_ALLOW_PROTOCOL=https:ssh refuses a local path remote, so tests need file added", () => {
    expect(() =>
      git(["clone", "-q", "--no-checkout", "--", remote, join(work, "refused")], work, {
        GIT_ALLOW_PROTOCOL: "https:ssh",
      }),
    ).toThrow(/transport 'file' not allowed/);
    expect(existsSync(join(work, "refused"))).toBe(false);
  });

  it("--template= leaves an empty hooks directory", () => {
    const clone = cloneNoCheckout("bare-template");
    const hooks = join(clone, ".git", "hooks");
    expect(existsSync(hooks) ? readdirSync(hooks) : []).toEqual([]);
  });

  it("a planted post-checkout hook does not run under core.hooksPath=/dev/null", () => {
    // After a --no-checkout clone the local branch is unborn, so `checkout --detach <branch>` is read
    // as "create a branch" and refused; the plan's sequence, fetch then FETCH_HEAD, is what works.
    const clone = cloneNoCheckout("hooked");
    const hooks = join(clone, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    const marker = join(work, "hook-ran");
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(hooks, "post-checkout"), 0o755);
    git(
      ["-c", "core.hooksPath=/dev/null", "checkout", "-q", "--detach", "--force", "FETCH_HEAD"],
      clone,
    );
    expect(existsSync(marker)).toBe(false);
    git(["checkout", "-q", "--detach", "--force", "FETCH_HEAD"], clone);
    expect(existsSync(marker)).toBe(true);
  });
});
