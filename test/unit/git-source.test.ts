import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CAPS } from "../../src/bundle/model.js";
import { createGitSource, isStaleLockMessage, sshBatchSetting } from "../../src/source/git.js";
import { createGitRunner, type GitRunner } from "../../src/source/git-runner.js";

const NOW = new Date("2026-10-07T10:00:00Z");
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "okf-catalog-git-source-"));
  dirs.push(d);
  return d;
};

/** A source repository with a `published` branch and a bare mirror reached through file://. */
function remote(files: Record<string, string | Buffer>) {
  const root = temp();
  const src = join(root, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "published");
  const write = (next: Record<string, string | Buffer>) => {
    for (const [path, body] of Object.entries(next)) {
      mkdirSync(join(src, path, ".."), { recursive: true });
      writeFileSync(join(src, path), body);
    }
  };
  const commit = (message: string): string => {
    git(src, "add", "-A");
    git(src, "commit", "-q", "--allow-empty", "-m", message);
    return git(src, "rev-parse", "HEAD");
  };
  write(files);
  const first = commit("one");
  const bare = join(root, "origin.git");
  git(root, "clone", "-q", "--bare", "--", src, bare);
  const push = (): void => {
    git(src, "push", "-q", "--force", "--", bare, "published:published");
  };
  return { root, src, bare, url: `file://${bare}`, write, commit, push, first };
}

const PAGE = (title: string) =>
  `---\ntype: Term\ntitle: ${title}\nstatus: stable\nverified:\n  - by: human:x\n    at: 2026-01-01T00:00:00Z\n---\n\nbody of ${title}\n`;

const trees = (work: string): string[] => readdirSync(work).filter((n) => n.startsWith("tree-"));

/** A runner that also counts the git subcommands it ran. */
function countingRunner(cacheRoot: string): GitRunner & {
  commands: string[];
  calls: Array<{ args: readonly string[]; extraConfig: readonly string[] }>;
} {
  const inner = createGitRunner({
    binary: execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
    allowProtocols: "https:ssh:file",
    cacheRoot,
    env: GIT_ENV,
  });
  const commands: string[] = [];
  const calls: Array<{ args: readonly string[]; extraConfig: readonly string[] }> = [];
  return {
    commands,
    calls,
    env: inner.env,
    run: (args, options) => {
      commands.push(args[0] ?? "");
      calls.push({ args, extraConfig: options.extraConfig ?? [] });
      return inner.run(args, options);
    },
    abort: () => inner.abort(),
    get running() {
      return inner.running;
    },
  };
}

function source(
  url: string,
  work: string,
  patch: Partial<Parameters<typeof createGitSource>[0]> = {},
) {
  const runner = countingRunner(work);
  const src = createGitSource({
    repository: url,
    branch: "published",
    bundlePath: ".",
    workDir: join(work, "source"),
    caps: DEFAULT_CAPS,
    runner,
    clock: () => NOW,
    ...patch,
  });
  return { src, runner };
}

describe("createGitSource", { timeout: 60_000 }, () => {
  it("clones bare, fetches, extracts the validated tree into a folder of its own and walks it", async () => {
    const r = remote({ "kb/a.md": PAGE("A"), "kb/b.md": PAGE("B"), "viz.html": "<p>x</p>\n" });
    const work = temp();
    const { src, runner } = source(r.url, work);
    const loaded = await src.load();
    expect(loaded.published?.commit).toBe(r.first);
    expect(loaded.published?.fetchedAt).toEqual(NOW);
    expect(loaded.walk.fatal).toBeUndefined();
    expect(loaded.walk.files.map((f) => f.path).sort()).toEqual(["kb/a.md", "kb/b.md", "viz.html"]);
    expect(
      Buffer.from(loaded.walk.files.find((f) => f.path === "kb/a.md")?.bytes ?? []).toString(),
    ).toBe(PAGE("A"));
    expect(existsSync(join(work, "source", "repo.git", "HEAD"))).toBe(true);
    expect(trees(join(work, "source"))).toEqual([`tree-${r.first}`]);
    const state = JSON.parse(readFileSync(join(work, "source", "state.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(state).toMatchObject({
      repository: r.url,
      branch: "published",
      extracted: r.first,
      fetchedAt: NOW.toISOString(),
    });
    expect(runner.commands).toEqual([
      "config",
      "clone",
      "fetch",
      "rev-parse",
      "ls-tree",
      "cat-file",
    ]);
    expect(src.describe()).toBe(r.url);
  });

  it("lists and extracts nothing when the fetched commit is the one already extracted", async () => {
    const r = remote({ "a.md": PAGE("A") });
    const work = temp();
    const { src, runner } = source(r.url, work);
    await src.load();
    runner.commands.length = 0;
    const again = await src.load();
    expect(again.published?.commit).toBe(r.first);
    expect(runner.commands).toEqual(["config", "fetch", "rev-parse"]);
    expect(trees(join(work, "source"))).toHaveLength(1);
  });

  it("follows an update, a removed file, a force-push and a branch that moves backwards, pruning trees once told what is served", async () => {
    const r = remote({ "a.md": PAGE("A"), "gone.md": PAGE("Gone") });
    const work = temp();
    const { src } = source(r.url, work);
    const one = (await src.load()).published?.commit;
    src.served(one ?? "");
    r.write({ "a.md": PAGE("A2") });
    rmSync(join(r.src, "gone.md"));
    const two = r.commit("two");
    r.push();
    const updated = await src.load();
    expect(updated.published?.commit).toBe(two);
    expect(updated.walk.files.map((f) => f.path)).toEqual(["a.md"]);
    expect(Buffer.from(updated.walk.files[0]?.bytes ?? []).toString()).toContain("A2");
    expect(trees(join(work, "source")).sort()).toEqual([`tree-${one}`, `tree-${two}`].sort());
    src.served(two);
    expect(trees(join(work, "source"))).toEqual([`tree-${two}`]);
    // Backwards: the remote branch is reset to the first commit and force-pushed.
    git(r.src, "reset", "-q", "--hard", one ?? "");
    r.push();
    const back = await src.load();
    expect(back.published?.commit).toBe(one);
    expect(back.walk.files.map((f) => f.path).sort()).toEqual(["a.md", "gone.md"]);
  });

  it("refuses a commit with a symbolic link or an oversize blob before extracting anything, keeping the previous tree", async () => {
    const r = remote({ "a.md": PAGE("A") });
    const work = temp();
    const { src, runner } = source(r.url, work);
    const one = (await src.load()).published?.commit ?? "";
    symlinkSync("a.md", join(r.src, "link.md"));
    const two = r.commit("link");
    r.push();
    runner.commands.length = 0;
    const refused = await src.load();
    expect(refused.walk.fatal).toMatchObject({ rule: "symlink", path: "link.md" });
    expect(refused.published?.commit).toBe(two);
    expect(runner.commands).not.toContain("cat-file");
    expect(trees(join(work, "source"))).toEqual([`tree-${one}`]);
    rmSync(join(r.src, "link.md"));
    r.write({ "big.bin": Buffer.alloc(3000, 1) });
    r.commit("big");
    r.push();
    const small = source(r.url, temp(), { caps: { ...DEFAULT_CAPS, fileBytes: 2000 } });
    const tooBig = await small.src.load();
    expect(tooBig.walk.fatal).toMatchObject({ rule: "oversize", path: "big.bin" });
  });

  it("extracts raw bytes: a CRLF blob under text=auto and a filter from a planted global configuration arrives unchanged", async () => {
    // The blob is committed before the attributes exist, so it keeps its CRLF bytes; a checkout would then apply them.
    const r = remote({ "crlf.md": "---\ntype: Term\ntitle: C\n---\r\n\r\nline\r\n" });
    r.write({ ".gitattributes": "* text=auto\n*.md filter=shout\n" });
    r.commit("attributes");
    r.push();
    const home = temp();
    writeFileSync(
      join(home, ".gitconfig"),
      '[filter "shout"]\n\tsmudge = tr a-z A-Z\n\tclean = cat\n',
    );
    const work = temp();
    const runner = createGitRunner({
      binary: execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
      allowProtocols: "https:ssh:file",
      cacheRoot: work,
      env: { ...GIT_ENV, HOME: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig") },
    });
    const src = createGitSource({
      repository: r.url,
      branch: "published",
      bundlePath: ".",
      workDir: join(work, "source"),
      caps: DEFAULT_CAPS,
      runner,
      clock: () => NOW,
    });
    const loaded = await src.load();
    const file = loaded.walk.files.find((f) => f.path === "crlf.md");
    expect(Buffer.from(file?.bytes ?? []).toString("latin1")).toBe(
      "---\ntype: Term\ntitle: C\n---\r\n\r\nline\r\n",
    );
  });

  it("walks the configured bundle path inside the tree and refuses a path the tree lacks", async () => {
    const r = remote({ "kb/a.md": PAGE("A"), "README.md": "not a page\n" });
    const work = temp();
    const { src } = source(r.url, work, { bundlePath: "kb" });
    const loaded = await src.load();
    expect(loaded.walk.files.map((f) => f.path)).toEqual(["a.md"]);
    const missing = source(r.url, temp(), { bundlePath: "docs" });
    expect((await missing.src.load()).walk.fatal).toMatchObject({
      rule: "bundle-path-missing",
      path: "docs",
    });
  });

  it("serves the tree on disk at once when a fresh process starts offline, and tells the poller the remote moved or is gone", async () => {
    const r = remote({ "a.md": PAGE("A") });
    const work = temp();
    const { src } = source(r.url, work);
    const one = (await src.load()).published?.commit ?? "";
    src.served(one);
    expect(await src.changed()).toBe("same");
    r.write({ "a.md": PAGE("A2") });
    r.commit("two");
    r.push();
    expect(await src.changed()).toBe("moved");
    // A fresh process, the remote gone: the served tree answers at once.
    rmSync(r.bare, { recursive: true, force: true });
    const fresh = source(r.url, work);
    const offline = await fresh.src.load();
    expect(offline.published?.commit).toBe(one);
    expect(offline.walk.files.map((f) => f.path)).toEqual(["a.md"]);
    expect(fresh.runner.commands).toEqual([]);
    await expect(fresh.src.load()).rejects.toThrow(/could not be fetched|fetch/);
    const served = await fresh.src.loadServed();
    expect(served?.published?.commit).toBe(one);
  });

  it("names the repository as configured, never the work folder, when nothing can be fetched and nothing is on disk", async () => {
    const work = temp();
    const { src } = source("file:///nowhere/at/all.git", work);
    const error = (await src.load().then(
      () => undefined,
      (e: unknown) => e,
    )) as (Error & { detail?: string }) | undefined;
    expect(error?.message).toContain("file:///nowhere/at/all.git");
    expect(error?.message).not.toContain(work);
    expect(error?.detail ?? "").toContain("nowhere");
  });

  it("recreates a clone that is missing, that belongs to another repository, or that a killed git left locked", async () => {
    const r = remote({ "a.md": PAGE("A") });
    const work = temp();
    const { src } = source(r.url, work);
    await src.load();
    rmSync(join(work, "source", "repo.git"), { recursive: true, force: true });
    expect((await src.load()).published?.commit).toBe(r.first);
    writeFileSync(join(work, "source", "repo.git", "shallow.lock"), "");
    expect((await src.load()).published?.commit).toBe(r.first);
    expect(existsSync(join(work, "source", "repo.git", "shallow.lock"))).toBe(false);
    const other = remote({ "b.md": PAGE("B") });
    const switched = source(other.url, work);
    const loaded = await switched.src.load();
    expect(loaded.walk.files.map((f) => f.path)).toEqual(["b.md"]);
    expect(trees(join(work, "source"))).toEqual([`tree-${other.first}`]);
  });

  it("refuses a source folder that is a symbolic link and hides a credential in describe()", async () => {
    const work = temp();
    const elsewhere = temp();
    symlinkSync(elsewhere, join(work, "source"));
    const { src } = source("https://alice:secret@host.example/o/r.git", work);
    expect(src.describe()).toBe("https://***@host.example/o/r.git");
    await expect(src.load()).rejects.toThrow(/symbolic link/);
  });

  it("tells the poller the remote moved until the runtime has served the fetched commit, and stays quiet on a refused one", async () => {
    const r = remote({ "a.md": PAGE("A") });
    const work = temp();
    const { src } = source(r.url, work);
    const one = (await src.load()).published?.commit ?? "";
    src.served(one);
    expect(await src.changed()).toBe("same");
    r.write({ "a.md": PAGE("A2") });
    const two = r.commit("two");
    r.push();
    expect(await src.changed()).toBe("moved");
    // Fetched and extracted, but the runtime never swapped it in (its index failed): still moved.
    expect((await src.load()).published?.commit).toBe(two);
    expect(await src.changed()).toBe("moved");
    src.served(two);
    expect(await src.changed()).toBe("same");
    // A refused commit is remembered as attempted, so it is not fetched again every tick.
    symlinkSync("a.md", join(r.src, "link.md"));
    r.commit("link");
    r.push();
    expect((await src.load()).walk.fatal?.rule).toBe("symlink");
    expect(await src.changed()).toBe("same");
  });

  it("adds BatchMode to ssh only when neither variable nor configuration names an ssh command", async () => {
    expect(sshBatchSetting({}, undefined)).toEqual(["core.sshCommand=ssh -o BatchMode=yes"]);
    expect(sshBatchSetting({ GIT_SSH_COMMAND: "ssh -i key" }, undefined)).toEqual([]);
    expect(sshBatchSetting({ GIT_SSH: "/usr/bin/myssh" }, undefined)).toEqual([]);
    expect(sshBatchSetting({}, "ssh -o IdentitiesOnly=yes")).toEqual([]);
    const r = remote({ "a.md": PAGE("A") });
    const work = temp();
    const { src, runner } = source(r.url, work);
    await src.load();
    const transport = runner.calls.filter((c) =>
      ["clone", "fetch", "ls-remote"].includes(c.args[0] ?? ""),
    );
    expect(transport.length).toBeGreaterThan(0);
    for (const call of transport)
      expect(call.extraConfig).toContain("core.sshCommand=ssh -o BatchMode=yes");
    expect(
      runner.calls.some((c) => c.args[0] === "config" && c.args.includes("core.sshCommand")),
    ).toBe(true);
  });

  it("ignores a state file whose commits are not hashes and a tree folder that is a link", async () => {
    const r = remote({ "a.md": PAGE("A") });
    const work = temp();
    const { src } = source(r.url, work);
    const one = (await src.load()).published?.commit ?? "";
    src.served(one);
    const statePath = join(work, "source", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, string>;
    writeFileSync(
      statePath,
      JSON.stringify({ ...state, served: "ab/../../elsewhere", extracted: "../x" }),
    );
    expect(await src.loadServed()).toBeUndefined();
    writeFileSync(statePath, JSON.stringify(state));
    rmSync(join(work, "source", `tree-${one}`), { recursive: true, force: true });
    const elsewhere = temp();
    writeFileSync(join(elsewhere, "a.md"), PAGE("Planted"));
    symlinkSync(elsewhere, join(work, "source", `tree-${one}`));
    expect(await src.loadServed()).toBeUndefined();
  });

  it("recognises git's stale-lock sentence and nothing else", () => {
    expect(
      isStaleLockMessage("fatal: Unable to create '/x/repo.git/shallow.lock': File exists.\\u000a"),
    ).toBe(true);
    expect(
      isStaleLockMessage(
        "error: cannot lock ref 'refs/remotes/origin/published': Unable to create '/x/repo.git/refs/remotes/origin/published.lock': File exists.",
      ),
    ).toBe(true);
    expect(
      isStaleLockMessage(
        "fatal: unable to access 'https://host/repo.lock/': Could not resolve host",
      ),
    ).toBe(false);
    expect(
      isStaleLockMessage("fatal: could not read from remote repository; File exists elsewhere"),
    ).toBe(false);
  });
});
