import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CAPS, type LoadOptions } from "../../src/bundle/model.js";
import type { Generation } from "../../src/catalog/runtime.js";
import { renderDocument } from "../../src/engine/qmd-render.js";
import type { Engine, IndexResult } from "../../src/search/engine.js";
import { search } from "../../src/search/search.js";
import { createPoller } from "../../src/serve/poller.js";
import { createRuntime } from "../../src/serve/runtime.js";
import { createGitSource } from "../../src/source/git.js";
import { createGitRunner } from "../../src/source/git-runner.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RECIPE = join(REPO, "recipes", "publish");
const NOW = new Date("2026-10-07T12:00:00Z");
const NOW_ISO = "2026-10-07T12:00:00Z";
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
const quiet = { error() {}, warn() {}, info() {}, debug() {} };
const PAGE = (title: string, body: string) =>
  `---\ntype: Term\ntitle: ${title}\nstatus: stable\nverified:\n  - by: human:x\n    at: 2026-01-01T00:00:00Z\n---\n\n${body}\n`;

/** An engine over the rendered documents it is given: prefix match on every term. */
function engine(): Engine {
  let texts = new Map<string, string[]>();
  return {
    async index(docs): Promise<IndexResult> {
      texts = new Map(
        docs.map((d) => [
          d.path,
          `${d.path} ${renderDocument(d)}`
            .toLowerCase()
            .split(/[^\p{L}\p{N}\p{M}-]+/u)
            .filter((w) => w.length > 0),
        ]),
      );
      return {
        documents: docs.length,
        indexed: docs.length,
        updated: 0,
        unchanged: 0,
        removed: 0,
        skipped: 0,
        notIndexed: [],
        collisions: [],
        encodedFolders: [],
      };
    },
    async lex(terms, limit) {
      const hits = [];
      for (const [path, words] of texts) {
        let bm25 = 0;
        let all = true;
        for (const term of terms) {
          const n = words.filter((w) => w.startsWith(term)).length;
          if (n === 0) all = false;
          bm25 += n;
        }
        if (all && terms.length > 0) hits.push({ path, bm25, score: bm25 / (1 + bm25) });
      }
      return hits.sort((a, b) => b.bm25 - a.bm25 || (a.path < b.path ? -1 : 1)).slice(0, limit);
    },
    async status() {
      return { documents: texts.size };
    },
    async close() {},
  };
}

/** Stub checkers on PATH: they record their arguments and fail when told to, on the folder named. */
function stubCheckers(dir: string): { bin: string; log: string } {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "checkers.log");
  for (const name of ["okflint", "okf-schema"]) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(log)}\nif [ -n "\${FAIL_CHECK_ON:-}" ]; then case "$*" in *"$FAIL_CHECK_ON"*) echo "${name}: stub failing" >&2; exit 1 ;; esac; fi\nexit 0\n`,
    );
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, log };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("the publish loop", { timeout: 120_000 }, () => {
  it("packs and pushes with the recipe, serves the branch, picks up a change and a removal on the poller's tick, and refuses to push when a check fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "okf-catalog-loop-"));
    dirs.push(root);
    const { bin, log } = stubCheckers(root);
    // The person's own git configuration converts line endings and runs a clean filter: push.sh must not let it.
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(
      join(home, ".gitconfig"),
      '[core]\n\tautocrlf = input\n\tattributesfile = ~/.gitattributes\n[filter "shout"]\n\tclean = tr a-z A-Z\n\tsmudge = cat\n',
    );
    writeFileSync(join(home, ".gitattributes"), "* text=auto\n*.html filter=shout\n");
    writeFileSync(join(root, "okf-base.yaml"), "name: loop\n");
    const env = {
      ...GIT_ENV,
      HOME: home,
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      OKF_CATALOG_BIN: `${process.execPath} ${join(REPO, "dist", "cli.js")}`,
      OKF_CATALOG_NOW: NOW_ISO,
      OKFLINT_MANIFEST: join(root, "okf-base.yaml"),
      OKF_SCHEMA: "1",
    };
    const script = (name: string, args: string[], extra: Record<string, string> = {}) =>
      spawnSync("sh", [join(RECIPE, name), ...args], {
        env: { ...env, ...extra },
        encoding: "utf8",
      });

    // The company's source repository and the bare remote its workflow pushes to.
    const src = join(root, "src");
    mkdirSync(join(src, "kb"), { recursive: true });
    writeFileSync(join(src, "kb", "alpha.md"), PAGE("Alpha", "alpha one"));
    writeFileSync(join(src, "kb", "beta.md"), PAGE("Beta", "beta body"));
    writeFileSync(join(src, "kb", "crlf.html"), "<p>line one</p>\r\n<p>two</p>\r\n");
    writeFileSync(join(src, "okf-catalog.yaml"), "company: loop\nsource:\n  local: ./kb\n");
    git(src, "init", "-q", "-b", "main");
    git(src, "add", "-A");
    git(src, "commit", "-q", "-m", "one");
    const sha1 = git(src, "rev-parse", "HEAD");
    const origin = join(root, "origin.git");
    git(root, "init", "-q", "--bare", origin);
    // The workflow's checkout: shallow, of the source branch, with the remote the token lives on.
    git(root, "init", "-q", "--bare", join(root, "source.git"));
    git(src, "push", "-q", "--", join(root, "source.git"), "main:main");
    const clone = join(root, "clone");
    git(root, "clone", "-q", "--depth", "1", "--", `file://${join(root, "source.git")}`, clone);
    git(clone, "remote", "set-url", "origin", origin);

    // pack.sh: checkers, pack, checkers; it prints the commit it recorded.
    const packed1 = join(root, "packed1");
    const pack1 = script("pack.sh", [
      "--config",
      join(src, "okf-catalog.yaml"),
      "--source",
      join(src, "kb"),
      "--out",
      packed1,
      "--commit",
      sha1,
    ]);
    expect(pack1.status, pack1.stderr).toBe(0);
    expect(pack1.stdout.trim()).toBe(sha1);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      `okflint validate --manifest ${join(root, "okf-base.yaml")} ${join(src, "kb")}`,
      `okf-schema validate --path ${join(src, "kb")}`,
      `okflint validate --manifest ${join(root, "okf-base.yaml")} ${packed1}`,
      `okf-schema validate --path ${packed1}`,
    ]);
    expect(JSON.parse(readFileSync(join(packed1, "manifest.json"), "utf8")).commit).toBe(sha1);

    // push.sh: the published branch appears, parent-linked from now on.
    const push1 = script("push.sh", ["--repo", clone, "--bundle", packed1, "--commit", sha1]);
    expect(push1.status, push1.stderr).toBe(0);
    const tip1 = git(origin, "rev-parse", "published");
    expect(git(origin, "rev-list", "--count", "published")).toBe("1");
    // The bytes on the branch are the bytes pack hashed: no line-ending conversion, no clean filter.
    expect(git(origin, "cat-file", "-p", "published:crlf.html")).toBe(
      "<p>line one</p>\r\n<p>two</p>",
    );
    expect(
      (
        JSON.parse(git(origin, "cat-file", "-p", "published:manifest.json")) as {
          files: Record<string, { bytes: number }>;
        }
      ).files["crlf.html"]?.bytes,
    ).toBe(29);
    expect(git(origin, "log", "-1", "--format=%s", "published")).toBe(`publish ${sha1}`);

    // The server side, in process: the git source over file://, the runtime, the poller driven by tick().
    const runner = createGitRunner({
      binary: execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
      allowProtocols: "https:ssh:file",
      cacheRoot: root,
      env: GIT_ENV,
    });
    const source = createGitSource({
      repository: `file://${origin}`,
      branch: "published",
      bundlePath: ".",
      workDir: join(root, "cache", "source"),
      caps: DEFAULT_CAPS,
      runner,
      clock: () => NOW,
    });
    const load: LoadOptions = {
      admit: ["stable", "deprecated"],
      dev: false,
      integrity: "require-manifest",
      specText: "2026-08-15",
      caps: DEFAULT_CAPS,
    };
    const runtime = createRuntime({
      company: "loop",
      source,
      prepare: async () => ({ engine: engine(), lock: "exclusive" as const }),
      load,
      clock: () => NOW,
      log: quiet,
    });
    const poller = createPoller({
      runtime,
      source: () => source,
      intervalMs: 60_000,
      log: quiet,
      clock: () => NOW,
    });
    runtime.start();
    const first = await runtime.ready();
    expect(first.published?.commit).toBe(tip1);
    expect(first.report.integrity).toBe("checked");
    expect([...first.catalog.pages.keys()].sort()).toEqual(["alpha.md", "beta.md"]);
    const found = await runtime.lease((g: Generation, e: Engine) =>
      search(g.catalog, e, { question: "alpha", includeStale: false, limit: 5 }, NOW),
    );
    expect(found.hits.map((h) => h.path)).toEqual(["alpha.md"]);

    // A change and a removal, published again: the next tick serves them.
    writeFileSync(join(src, "kb", "alpha.md"), PAGE("Alpha", "alpha two"));
    rmSync(join(src, "kb", "beta.md"));
    git(src, "add", "-A");
    git(src, "commit", "-q", "-m", "two");
    const sha2 = git(src, "rev-parse", "HEAD");
    const packed2 = join(root, "packed2");
    expect(
      script("pack.sh", [
        "--config",
        join(src, "okf-catalog.yaml"),
        "--source",
        join(src, "kb"),
        "--out",
        packed2,
        "--commit",
        sha2,
      ]).status,
    ).toBe(0);
    const push2 = script("push.sh", ["--repo", clone, "--bundle", packed2, "--commit", sha2]);
    expect(push2.status, push2.stderr).toBe(0);
    const tip2 = git(origin, "rev-parse", "published");
    expect(git(origin, "rev-list", "--count", "published")).toBe("2");
    expect(git(origin, "rev-parse", "published~1")).toBe(tip1);
    expect(await poller.tick()).toBe("refreshed");
    // ready() is the first load's generation; the one served now is what a lease reads.
    const second = await runtime.lease(async (g: Generation) => g);
    expect(second.published?.commit).toBe(tip2);
    expect(second.catalog.pages.get("alpha.md")?.body).toContain("alpha two");
    expect(second.catalog.pages.has("beta.md")).toBe(false);
    const gone = await runtime.lease((g: Generation, e: Engine) =>
      search(g.catalog, e, { question: "beta", includeStale: false, limit: 5 }, NOW),
    );
    expect(gone.hits).toEqual([]);
    expect(await poller.tick()).toBe("unchanged");

    // A checker that fails after pack stops the publish: nothing new reaches the branch.
    const packed3 = join(root, "packed3");
    // Without an okflint manifest, okflint is left out and okf-schema still runs.
    writeFileSync(log, "");
    const packed4 = join(root, "packed4");
    const noLint = script(
      "pack.sh",
      [
        "--config",
        join(src, "okf-catalog.yaml"),
        "--source",
        join(src, "kb"),
        "--out",
        packed4,
        "--commit",
        sha2,
      ],
      { OKFLINT_MANIFEST: "" },
    );
    expect(noLint.status, noLint.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).not.toMatch(/okflint/);
    expect(readFileSync(log, "utf8")).toMatch(/okf-schema validate --path/);
    const failing = script(
      "pack.sh",
      [
        "--config",
        join(src, "okf-catalog.yaml"),
        "--source",
        join(src, "kb"),
        "--out",
        packed3,
        "--commit",
        sha2,
      ],
      { FAIL_CHECK_ON: packed3 },
    );
    expect(failing.status).not.toBe(0);
    expect(failing.stderr).toMatch(/stub failing/);
    expect(git(origin, "rev-parse", "published")).toBe(tip2);
    await poller.stop();
    await runtime.shutdown();
  });
});
