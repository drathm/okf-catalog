import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { runPack } from "../../src/commands/pack.js";
import { acquireLock } from "../../src/fs/company-lock.js";
import {
  CLI,
  INITIALIZE,
  INITIALIZED,
  impureLines,
  NOW_ISO,
  REPO,
  rawServer,
  type Sandbox,
  sandbox,
} from "../helpers/stdio.js";

const boxes: Sandbox[] = [];
afterEach(() => {
  for (const b of boxes) b.dispose();
  boxes.length = 0;
});
const box = (fixture = "spec-example", yaml?: string): Sandbox => {
  const b = sandbox(fixture, yaml);
  boxes.push(b);
  return b;
};
const companyDir = (b: Sandbox) => join(b.cacheRoot, "okf-catalog", "fixture");
const lockFile = (b: Sandbox) => join(companyDir(b), "lock.sqlite");
const waitForFile = async (path: string, ms: number): Promise<boolean> => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return existsSync(path);
};

/** The tools the server lists, in name order. */
const SIX_TOOLS = ["catalog", "citations", "get_page", "provenance", "search", "status"];

describe("okf-catalog serve over stdio", { timeout: 60_000 }, () => {
  it("serves the six tools to the SDK client, with the private cache under the sandbox and stderr piped", async () => {
    const b = box();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "serve", "--config", b.configPath],
      env: b.env,
      cwd: b.cwd,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(SIX_TOOLS);
    const search = (await client.callTool({
      name: "search",
      arguments: { question: "acme retail" },
    })) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(search.isError).not.toBe(true);
    expect(search.content[0]?.text).toMatch(/\d+ hits?/);
    const status = (await client.callTool({ name: "status", arguments: {} })) as {
      structuredContent: { lock: string; integrity: string; admitted: number };
    };
    expect(status.structuredContent.lock).toBe("exclusive");
    expect(status.structuredContent.integrity).toBe("checked");
    expect(status.structuredContent.admitted).toBe(9);
    expect(existsSync(join(companyDir(b), "lock.sqlite"))).toBe(true);
    await client.close();
    expect(stderr).toMatch(/"event":"serve.start"/);
    expect(stderr).not.toMatch(/Acme Retail is a/);
  });

  // The readiness ledger (issue 2's "Holds", D59, row 40): serve renders no `qmd: metadata:` block.
  it("writes no qmd metadata block into the copies it indexes", async () => {
    const b = box("behaviours");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "serve", "--config", b.configPath],
      env: b.env,
      cwd: b.cwd,
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    const status = (await client.callTool({ name: "status", arguments: {} })) as {
      structuredContent: { admitted: number };
    };
    expect(status.structuredContent.admitted).toBe(17);
    const copy = readFileSync(
      join(companyDir(b), "bundles", "fixture", "derived", "terms", "alpha.md"),
      "utf8",
    );
    expect(copy.startsWith("# Alpha\n")).toBe(true);
    expect(copy).not.toContain("qmd:");
    expect(copy).not.toContain("metadata:");
    await client.close();
  });

  it("writes nothing but JSON-RPC to stdout, loads only after initialize, and cleans up when stdin closes", async () => {
    const b = box();
    const run = rawServer(b);
    await new Promise((r) => setTimeout(r, 1500));
    // Nothing happened yet: no lock, no cache folder for the company.
    expect(existsSync(companyDir(b))).toBe(false);
    run.send(INITIALIZE);
    const init = await run.waitFor(1);
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("okf-catalog");
    expect((init.result as { instructions?: string }).instructions).toMatch(/cite/i);
    run.send(INITIALIZED);
    // The load starts on the notification alone: the lock appears before any tool is listed or called.
    expect(await waitForFile(lockFile(b), 5000)).toBe(true);
    run.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await run.waitFor(2);
    expect((list.result as { tools: unknown[] }).tools).toHaveLength(6);
    run.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_page", arguments: { path: "index.md" } },
    });
    const page = await run.waitFor(3);
    expect(JSON.stringify(page)).toContain("reserved index");
    expect(existsSync(join(companyDir(b), "lock.sqlite"))).toBe(true);
    const exit = await run.end();
    expect(exit.code).toBe(0);
    expect(impureLines(run.stdout())).toEqual([]);
    expect(run.stderr()).not.toMatch(/Acme Retail is a/);
    expect(run.stderr().match(/"event":"serve.shutdown"/g)).toHaveLength(1);
    // The lock is free again and no private folder was left behind.
    const lock = acquireLock(companyDir(b), new Date());
    expect(lock.kind).toBe("exclusive");
    if (lock.kind === "exclusive") lock.close();
    expect(existsSync(join(companyDir(b), "private"))).toBe(false);
  });

  it("catches a writer planted after its guard, and the purity assertion fails on a writer that bypasses the guard", async () => {
    const helpers = join(import.meta.dirname, "..", "helpers");
    const late = rawServer(box(), [], ["--import", join(helpers, "noisy-late.mjs")]);
    late.send(INITIALIZE);
    await late.waitFor(1);
    await new Promise((r) => setTimeout(r, 900));
    const lateExit = await late.end();
    expect(lateExit.code).toBe(0);
    expect(impureLines(late.stdout())).toEqual([]);
    expect(late.stderr()).toContain("late leak through process.stdout.write");
    const bypass = rawServer(box(), [], ["--import", join(helpers, "noisy-captured.mjs")]);
    bypass.send(INITIALIZE);
    await bypass.waitFor(1);
    await new Promise((r) => setTimeout(r, 900));
    await bypass.end();
    expect(impureLines(bypass.stdout())).toEqual(["leak through a captured writer"]);
  });

  it("exits cleanly on SIGTERM during the first load and leaves a cache the next run can use", async () => {
    // A bundle big enough that the load is still running when the signal lands.
    const bundle = join(mkdtempSync(join(tmpdir(), "okf-catalog-bigbundle-")), "kb");
    mkdirSync(bundle);
    for (let i = 0; i < 1500; i++) {
      writeFileSync(
        join(bundle, `p${i}.md`),
        `---\ntype: Note\ntitle: Page ${i}\n---\n\n${"word ".repeat(300)}\n`,
      );
    }
    const b = box(
      "spec-example",
      `company: fixture\nsource:\n  local: ${bundle}\nserve:\n  dev: true\n`,
    );
    const run = rawServer(b);
    run.send(INITIALIZE);
    await run.waitFor(1);
    run.send(INITIALIZED);
    run.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    });
    // The lock is taken at the start of the load, so its file proves the load is running when the signal lands.
    expect(await waitForFile(lockFile(b), 5000)).toBe(true);
    run.child.kill("SIGTERM");
    // The signal alone ends the process: stdin stays open, so the shutdown it logs is the signal's.
    const exit = await run.waitExit(15_000);
    expect(exit.timedOut).toBe(false);
    expect(exit.code).toBe(0);
    expect(run.stderr()).toMatch(/"event":"serve.shutdown","reason":"SIGTERM"/);
    expect(impureLines(run.stdout())).toEqual([]);
    const again = rawServer(b);
    again.send(INITIALIZE);
    await again.waitFor(1);
    again.send(INITIALIZED);
    again.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    });
    const status = await again.waitFor(2);
    expect(JSON.stringify(status)).toContain('"admitted":1500');
    await again.end();
  });

  it("exits at once on a second signal while the first shutdown is still draining", async () => {
    const b = box();
    const run = rawServer(b);
    run.send(INITIALIZE);
    await run.waitFor(1);
    run.send(INITIALIZED);
    run.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    });
    await run.waitFor(2);
    run.child.kill("SIGTERM");
    run.child.kill("SIGTERM");
    const exit = await run.end(5_000);
    expect(exit.signal).not.toBe("SIGKILL");
    expect([0, 130]).toContain(exit.code);
  });

  it("runs in a refusing mode when the configuration is missing, naming the fix in every tool", async () => {
    const b = box();
    const run = rawServer(b, ["--config", join(b.root, "nowhere.yaml")]);
    run.send(INITIALIZE);
    await run.waitFor(1);
    run.send(INITIALIZED);
    run.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search", arguments: { question: "alpha" } },
    });
    const r = await run.waitFor(2);
    expect(JSON.stringify(r)).toContain('"isError":true');
    expect(JSON.stringify(r)).toContain("nowhere.yaml");
    await run.end();
    expect(impureLines(run.stdout())).toEqual([]);
  });

  it("names the fix but never the cache path when the cache folder is unusable", async () => {
    const b = box();
    chmodSync(b.cacheRoot, 0o777);
    const run = rawServer(b);
    run.send(INITIALIZE);
    await run.waitFor(1);
    run.send(INITIALIZED);
    run.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    });
    const r = await run.waitFor(2);
    expect(JSON.stringify(r)).toContain('"isError":true');
    expect(JSON.stringify(r)).not.toContain(b.cacheRoot);
    expect(JSON.stringify(r)).toMatch(/writable|sticky/);
    await run.end();
    expect(run.stderr()).toContain(b.cacheRoot);
  });

  it("falls back to a private folder when another process holds the company lock, and removes it on exit", async () => {
    const b = box();
    const first = rawServer(b);
    first.send(INITIALIZE);
    await first.waitFor(1);
    first.send(INITIALIZED);
    first.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    });
    await first.waitFor(2);
    const second = rawServer(b);
    second.send(INITIALIZE);
    await second.waitFor(1);
    second.send(INITIALIZED);
    second.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    });
    const status = await second.waitFor(2);
    expect(JSON.stringify(status)).toContain('"lock":"private"');
    expect(readdirSync(join(companyDir(b), "private"))).toHaveLength(1);
    await second.end();
    expect(readdirSync(join(companyDir(b), "private"))).toHaveLength(0);
    await first.end();
  });
  it("stays up after the 2025-era handshake when the first load fails, naming the source as configured and never the resolved path", async () => {
    const b = box("spec-example", "company: fixture\nsource:\n  local: ./missing-kb\n");
    const run = rawServer(b);
    run.send(INITIALIZE);
    await run.waitFor(1);
    run.send(INITIALIZED);
    await new Promise((r) => setTimeout(r, 1000));
    expect(run.child.exitCode).toBeNull();
    run.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search", arguments: { question: "alpha" } },
    });
    const r = await run.waitFor(2);
    const result = r.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("./missing-kb");
    expect(result.content[0]?.text).toContain("does not exist");
    expect(result.content[0]?.text).not.toContain(b.root);
    expect(result.content[0]?.text).not.toContain("defect");
    const exit = await run.end();
    expect(exit.code).toBe(0);
    expect(run.stderr()).toMatch(/"event":"serve.refusing"/);
    expect(run.stderr()).toContain(join(b.root, "missing-kb"));
  });

  it("starts the first load on a tools/list with no handshake (the current protocol's path), and never on a ping", async () => {
    const b = box();
    const run = rawServer(b);
    run.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    await run.waitFor(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(companyDir(b))).toBe(false);
    run.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await run.waitFor(2);
    expect((list.result as { tools: unknown[] }).tools).toHaveLength(6);
    expect(await waitForFile(lockFile(b), 5000)).toBe(true);
    const exit = await run.end();
    expect(exit.code).toBe(0);
  });

  it("lists tools to a negotiating SDK client and has the bundle loaded by the time the listing is answered", async () => {
    const b = box();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "serve", "--config", b.configPath],
      env: b.env,
      cwd: b.cwd,
    });
    const client = new Client(
      { name: "test", version: "0.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(SIX_TOOLS);
    expect(await waitForFile(lockFile(b), 5000)).toBe(true);
    await client.close();
  });

  it("exits on its own, releasing the lock, when the client stops reading its output", async () => {
    const b = box();
    const run = rawServer(b);
    run.send(INITIALIZE);
    await run.waitFor(1);
    run.send(INITIALIZED);
    run.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    });
    await run.waitFor(2);
    run.child.stdout?.destroy();
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 20; i++) {
      run.send({
        jsonrpc: "2.0",
        id: 10 + i,
        method: "tools/call",
        params: { name: "catalog", arguments: {} },
      });
    }
    const exit = await run.waitExit(8000);
    expect(exit.timedOut).toBe(false);
    expect(exit.code).toBe(0);
    expect(run.stderr()).toMatch(/"event":"serve.shutdown"/);
    expect(run.stderr()).not.toMatch(/Unhandled 'error' event/);
    const lock = acquireLock(companyDir(b), new Date());
    expect(lock.kind).toBe("exclusive");
    if (lock.kind === "exclusive") lock.close();
  });
});

/** A published branch on a bare repository reached through file://, made with the system git. */
function publishedRepo(files: Record<string, string>): { url: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "okf-catalog-stdio-repo-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" });
  const src = join(root, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "published");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(src, path, ".."), { recursive: true });
    writeFileSync(join(src, path), body);
  }
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "one");
  git(root, "clone", "-q", "--bare", "--", src, join(root, "origin.git"));
  return { url: `file://${join(root, "origin.git")}`, root };
}

const PUBLISHED_PAGE = `---\ntype: Term\ntitle: Alpha\nstatus: stable\nverified:\n  - by: human:x\n    at: 2026-01-01T00:00:00Z\n---\n\nalpha body\n`;

describe("okf-catalog serve over stdio with a repository source", { timeout: 90_000 }, () => {
  it("serves a published branch, reports the fetched commit and the poller, and gives a second server its own source and the holder's name", async () => {
    // The published branch is what `pack` writes: the page, a generated index and the manifest.
    const packWork = mkdtempSync(join(tmpdir(), "okf-catalog-stdio-pack-"));
    mkdirSync(join(packWork, "kb"));
    writeFileSync(join(packWork, "kb", "alpha.md"), PUBLISHED_PAGE);
    writeFileSync(join(packWork, "okf-catalog.yaml"), "company: fixture\nsource:\n  local: ./kb\n");
    const packed = join(packWork, "out");
    expect(
      runPack(
        [
          "--config",
          join(packWork, "okf-catalog.yaml"),
          "--from",
          join(packWork, "kb"),
          "--out",
          packed,
        ],
        {
          stdout: () => undefined,
          stderr: (m) => void process.stderr.write(m),
          env: { OKF_CATALOG_NOW: NOW_ISO },
        },
      ),
    ).toBe(0);
    const repo = publishedRepo(
      Object.fromEntries(
        readdirSync(packed).map((name) => [name, readFileSync(join(packed, name), "utf8")]),
      ),
    );
    rmSync(packWork, { recursive: true, force: true });
    try {
      const yaml = `company: fixture\nsource:\n  repository: "${repo.url}"\n  branch: published\n`;
      const b = box("spec-example", yaml);
      b.env.OKF_CATALOG_GIT_PROTOCOLS = "file";
      const first = rawServer(b);
      first.send(INITIALIZE);
      await first.waitFor(1);
      first.send(INITIALIZED);
      first.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "status", arguments: {} },
      });
      const status = (await first.waitFor(2)).result as {
        structuredContent: {
          lock: string;
          admitted: number;
          published: { commit: string; fetchedAt: string } | null;
          poller: { intervalMs: number } | null;
          lockOwner: unknown;
          source: string;
        };
      };
      expect(status.structuredContent.admitted).toBe(1);
      expect(status.structuredContent.lock).toBe("exclusive");
      expect(status.structuredContent.published?.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(status.structuredContent.published?.fetchedAt).toBe(NOW_ISO.replace("Z", ".000Z"));
      expect(status.structuredContent.poller?.intervalMs).toBe(600_000);
      expect(status.structuredContent.lockOwner).toBeNull();
      expect(status.structuredContent.source).toBe(repo.url);
      // Each bundle's clone lives in its own folder under the network's (D73).
      expect(
        existsSync(join(companyDir(b), "bundles", "fixture", "source", "repo.git", "HEAD")),
      ).toBe(true);
      expect(existsSync(join(companyDir(b), "source"))).toBe(false);
      first.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_page", arguments: { path: "alpha.md" } },
      });
      expect(JSON.stringify(await first.waitFor(3))).toContain("alpha body");

      const second = rawServer(b);
      second.send(INITIALIZE);
      await second.waitFor(1);
      second.send(INITIALIZED);
      second.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "status", arguments: {} },
      });
      const other = (await second.waitFor(2)).result as {
        structuredContent: {
          lock: string;
          lockOwner: { pid: number; alive: boolean } | null;
          admitted: number;
        };
        content: Array<{ text: string }>;
      };
      expect(other.structuredContent.lock).toBe("private");
      expect(other.structuredContent.lockOwner).toMatchObject({
        pid: first.child.pid,
        alive: true,
      });
      expect(other.structuredContent.admitted).toBe(1);
      expect((other.structuredContent as unknown as { poller: unknown }).poller).not.toBeNull();
      expect(other.content[0]?.text).toMatch(/lock private \(held by pid \d+ since .*, alive\)/);
      const privateSources = readdirSync(join(companyDir(b), "private")).map((pid) =>
        existsSync(
          join(companyDir(b), "private", pid, "bundles", "fixture", "source", "repo.git", "HEAD"),
        ),
      );
      expect(privateSources).toEqual([true]);
      expect((await second.end()).code).toBe(0);
      expect((await first.end()).code).toBe(0);
      expect(first.stderr()).toMatch(/"event":"load.done"/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it("serves its cache and reports the last fetch when the remote cannot be asked, and keeps serving on a failed tick", async () => {
    const packWork = mkdtempSync(join(tmpdir(), "okf-catalog-stdio-offline-"));
    mkdirSync(join(packWork, "kb"));
    writeFileSync(join(packWork, "kb", "alpha.md"), PUBLISHED_PAGE);
    writeFileSync(join(packWork, "okf-catalog.yaml"), "company: fixture\nsource:\n  local: ./kb\n");
    const packed = join(packWork, "out");
    expect(
      runPack(
        [
          "--config",
          join(packWork, "okf-catalog.yaml"),
          "--from",
          join(packWork, "kb"),
          "--out",
          packed,
        ],
        {
          stdout: () => undefined,
          stderr: (m) => void process.stderr.write(m),
          env: { OKF_CATALOG_NOW: NOW_ISO },
        },
      ),
    ).toBe(0);
    const repo = publishedRepo(
      Object.fromEntries(
        readdirSync(packed).map((name) => [name, readFileSync(join(packed, name), "utf8")]),
      ),
    );
    rmSync(packWork, { recursive: true, force: true });
    try {
      const yaml = `company: fixture\nsource:\n  repository: "${repo.url}"\n  branch: published\n`;
      const b = box("spec-example", yaml);
      b.env.OKF_CATALOG_GIT_PROTOCOLS = "file";
      const statusOf = async (run: ReturnType<typeof rawServer>, id: number) => {
        run.send({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "status", arguments: {} },
        });
        return (await run.waitFor(id)).result as {
          structuredContent: { published: { commit: string; fetchedAt: string } | null };
        };
      };
      // The first server fetches the branch and is ended cleanly, so the lock is free and the tree is on disk.
      const first = rawServer(b);
      first.send(INITIALIZE);
      await first.waitFor(1);
      first.send(INITIALIZED);
      const before = await statusOf(first, 2);
      expect(before.structuredContent.published?.fetchedAt).toBe(NOW_ISO.replace("Z", ".000Z"));
      const commit = before.structuredContent.published?.commit;
      expect((await first.end()).code).toBe(0);

      // The remote goes away. The second server starts under a later clock, so a fetch time it made up would show.
      renameSync(join(repo.root, "origin.git"), join(repo.root, "origin.moved"));
      b.env.OKF_CATALOG_NOW = "2026-10-07T12:00:00Z";
      const second = rawServer(b);
      second.send(INITIALIZE);
      await second.waitFor(1);
      second.send(INITIALIZED);
      const after = await statusOf(second, 2);
      expect(after.structuredContent.published?.commit).toBe(commit);
      expect(after.structuredContent.published?.fetchedAt).toBe(NOW_ISO.replace("Z", ".000Z"));
      second.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search", arguments: { question: "alpha" } },
      });
      expect(JSON.stringify(await second.waitFor(3))).toContain("alpha.md");
      // A server that started from disk ticks at once; the tick must fail (the remote cannot be asked), never
      // read as a deleted branch, and the server must still answer afterwards.
      const started = Date.now();
      while (!/"event":"poller.tick"/.test(second.stderr()) && Date.now() - started < 20_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const tick = second
        .stderr()
        .split("\n")
        .find((line) => line.includes('"event":"poller.tick"'));
      expect(tick).toBeDefined();
      expect(tick).toContain('"outcome":"failed"');
      expect(tick).not.toContain('"outcome":"gone"');
      expect(tick).toContain("could not be asked");
      expect(tick).toContain(repo.url);
      const still = await statusOf(second, 4);
      expect(still.structuredContent.published?.fetchedAt).toBe(NOW_ISO.replace("Z", ".000Z"));
      expect((await second.end()).code).toBe(0);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it("ends cleanly, leaving no git process behind, when stdin closes during a clone", async () => {
    const standIn = mkdtempSync(join(tmpdir(), "okf-catalog-standin-"));
    const marker = `okfclone${process.pid}${Date.now()}`;
    writeFileSync(
      join(standIn, "git"),
      `#!/usr/bin/env node
if (process.argv.includes("--version")) { process.stdout.write("git version 2.54.0\\n"); process.exit(0); }
if (process.argv.includes("clone")) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", ${JSON.stringify(marker)}], { stdio: "ignore" });
  await new Promise((r) => child.on("exit", r));
}
process.exit(0);
`,
    );
    chmodSync(join(standIn, "git"), 0o755);
    try {
      const yaml = `company: fixture\nsource:\n  repository: "https://host.example/org/repo.git"\n`;
      const b = box("spec-example", yaml);
      b.env.PATH = `${standIn}:${b.env.PATH ?? ""}`;
      const run = rawServer(b);
      run.send(INITIALIZE);
      await run.waitFor(1);
      run.send(INITIALIZED);
      await new Promise((r) => setTimeout(r, 1200));
      const exit = await run.end(10_000);
      expect(exit.code).toBe(0);
      await new Promise((r) => setTimeout(r, 400));
      const probe = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
      if (probe.status !== 0 && probe.status !== 1)
        throw new Error(`pgrep failed: ${probe.stderr}`);
      expect(probe.status).toBe(1);
      expect(run.stderr()).toMatch(/"event":"serve.shutdown"/);
    } finally {
      rmSync(standIn, { recursive: true, force: true });
    }
  });

  it("names the fix, not SQLite's words, when the company lock database is unusable", async () => {
    const b = box();
    mkdirSync(companyDir(b), { recursive: true, mode: 0o700 });
    writeFileSync(join(companyDir(b), "lock.sqlite"), "not a database at all");
    const run = rawServer(b);
    run.send(INITIALIZE);
    await run.waitFor(1);
    run.send(INITIALIZED);
    run.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    });
    const r = (await run.waitFor(2)).result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/lock database/);
    expect(r.content[0]?.text).not.toMatch(/not a database/);
    expect(r.content[0]?.text).not.toContain(companyDir(b));
    expect((await run.end()).code).toBe(0);
  });
});

/** The published branch of one page, as `pack` writes it, on a bare repository reached through file://. */
function packedRepo(): { url: string; root: string } {
  const packWork = mkdtempSync(join(tmpdir(), "okf-catalog-stdio-net-pack-"));
  mkdirSync(join(packWork, "kb"));
  writeFileSync(join(packWork, "kb", "alpha.md"), PUBLISHED_PAGE);
  writeFileSync(join(packWork, "okf-catalog.yaml"), "company: fixture\nsource:\n  local: ./kb\n");
  const packed = join(packWork, "out");
  const code = runPack(
    [
      "--config",
      join(packWork, "okf-catalog.yaml"),
      "--from",
      join(packWork, "kb"),
      "--out",
      packed,
    ],
    { stdout: () => undefined, stderr: () => undefined, env: { OKF_CATALOG_NOW: NOW_ISO } },
  );
  if (code !== 0) throw new Error(`pack exited ${code}`);
  const repo = publishedRepo(
    Object.fromEntries(
      readdirSync(packed).map((name) => [name, readFileSync(join(packed, name), "utf8")]),
    ),
  );
  rmSync(packWork, { recursive: true, force: true });
  return repo;
}

/** A status call over the raw protocol, its structured content. */
async function statusOver(
  run: ReturnType<typeof rawServer>,
  id: number,
): Promise<Record<string, unknown>> {
  run.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "status", arguments: {} } });
  return ((await run.waitFor(id)).result as { structuredContent: Record<string, unknown> })
    .structuredContent;
}

/** What a version 0 server left at the root of its folder: the clone, the link and its generation (D73). */
function plantVersion0(dir: string): void {
  mkdirSync(join(dir, "source"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "source", "state.json"), '{"planted":"version 0"}\n');
  mkdirSync(join(dir, "gen-1-1-1"), { recursive: true });
  writeFileSync(join(dir, "gen-1-1-1", "page.md"), "# Page\n");
  symlinkSync("gen-1-1-1", join(dir, "derived"));
}

// Issue 3, D72 and D73: one process, one lock, one store for a network; each bundle's folder under bundles/<id>.
describe("okf-catalog serve over stdio: a network (D72, D73)", { timeout: 90_000 }, () => {
  it("serves two local bundles from one lock and one store", async () => {
    const fixtures = join(REPO, "test", "fixtures", "bundles");
    const yaml = `network: fixture\nbundles:\n  - id: terms\n    source:\n      local: ${join(fixtures, "behaviours")}\n  - id: acme\n    source:\n      local: ${join(fixtures, "spec-example")}\n`;
    const b = box("spec-example", yaml);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "serve", "--config", b.configPath],
      env: b.env,
      cwd: b.cwd,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    const status = (await client.callTool({ name: "status", arguments: {} })) as {
      structuredContent: {
        network: string;
        lock: string;
        bundles: Array<{ id: string; admitted: number; sourceKind: string; source: string }>;
      };
    };
    expect(status.structuredContent.network).toBe("fixture");
    expect(status.structuredContent.lock).toBe("exclusive");
    expect(
      status.structuredContent.bundles.map((row) => [row.id, row.admitted, row.sourceKind]),
    ).toEqual([
      ["terms", 17, "local"],
      ["acme", 9, "local"],
    ]);
    const hitsOf = async (question: string) =>
      (
        (await client.callTool({ name: "search", arguments: { question } })) as {
          structuredContent: { hits: Array<{ bundle: string; path: string }> };
        }
      ).structuredContent.hits;
    expect((await hitsOf("alpha glossary"))[0]).toMatchObject({
      bundle: "terms",
      path: "terms/alpha.md",
    });
    expect((await hitsOf("revenue")).some((hit) => hit.bundle === "acme")).toBe(true);
    await client.close();
    // One lock and one store for the network; each bundle's generations behind its own link.
    const dir = companyDir(b);
    expect(existsSync(join(dir, "lock.sqlite"))).toBe(true);
    expect(existsSync(join(dir, "index.sqlite"))).toBe(true);
    const locks = execFileSync("find", [b.cacheRoot, "-name", "lock.sqlite"], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.length > 0);
    expect(locks).toEqual([join(dir, "lock.sqlite")]);
    for (const id of ["terms", "acme"]) {
      expect(
        readdirSync(join(dir, "bundles", id)).filter((n) => n.startsWith("gen-")),
      ).toHaveLength(1);
      expect(existsSync(join(dir, "bundles", id, "derived"))).toBe(true);
    }
    expect(stderr).toMatch(
      /"event":"serve.start","network":"fixture","form":"network","bundles":\["terms","acme"\]/,
    );
    expect(stderr).not.toMatch(/"event":"serve.alias"/);
  });

  // D39 per bundle (the fold of bite c's build reviews, C-I-A1, C-I-A4, C-A-A1), from the adversarial review's d39
  // reproduction: one bundle's folder in the cache cannot be written, so its index and then its drop fail.
  it("serves the other bundle while one bundle's folder in the cache cannot be written, naming neither the cache path nor the engine's words", async () => {
    const fixtures = join(REPO, "test", "fixtures", "bundles");
    const yaml = `network: fixture\nbundles:\n  - id: terms\n    source:\n      local: ${join(fixtures, "behaviours")}\n  - id: acme\n    source:\n      local: ${join(fixtures, "spec-example")}\n`;
    const b = box("spec-example", yaml);
    const own = join(companyDir(b), "bundles", "acme");
    mkdirSync(own, { recursive: true, mode: 0o700 });
    chmodSync(own, 0o500);
    try {
      const run = rawServer(b);
      run.send(INITIALIZE);
      await run.waitFor(1);
      run.send(INITIALIZED);
      const call = async (id: number, name: string, args: Record<string, unknown>) => {
        run.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
        const answer = await run.waitFor(id);
        // Neither channel names the cache folder, nor carries the file system's words.
        expect(JSON.stringify(answer), name).not.toContain(b.cacheRoot);
        expect(JSON.stringify(answer), name).not.toMatch(/EACCES|permission denied/);
        return answer.result as {
          isError?: boolean;
          content: Array<{ text: string }>;
          structuredContent?: Record<string, unknown>;
        };
      };
      const found = await call(2, "search", { question: "alpha glossary" });
      expect(found.isError).not.toBe(true);
      expect(found.content[0]?.text.split("\n")[0]).toContain("not searched: acme (index-broken)");
      expect(
        (found.structuredContent as { hits: Array<{ bundle: string }> }).hits.every(
          (hit) => hit.bundle === "terms",
        ),
      ).toBe(true);
      const named = await call(3, "get_page", { path: "index.md", bundle: "acme" });
      expect(named.isError).toBe(true);
      expect(named.content[0]?.text).toMatch(
        /^the bundle acme was refused and nothing in it is served: index-broken: .*tried again when the server restarts/,
      );
      const status = await call(4, "status", {});
      expect(status.isError).not.toBe(true);
      expect(
        (status.structuredContent as { bundles: Array<{ id: string; state: string }> }).bundles.map(
          (row) => [row.id, row.state],
        ),
      ).toEqual([
        ["terms", "serving"],
        ["acme", "index-broken"],
      ]);
      expect((await run.end()).code).toBe(0);
      // The log carries what the model is not told: the folder and the file system's words, under the bundle.
      expect(run.stderr()).toMatch(/"event":"index.broken","bundle":"acme".*EACCES/);
      expect(run.stderr()).toContain(own);
    } finally {
      chmodSync(own, 0o700);
    }
  });

  // The fold of bite c's build reviews, C-I-A4: a network of one bundle refuses as a whole, as version 0 did (D74),
  // when its bundle's part of the index cannot be brought in line (D39) or its first load cannot be indexed; either
  // way the model reads a fixed sentence, and the log has the folder and the engine's words.
  it("refuses a one-bundle network whose index cannot take or drop its pages, naming neither the cache path nor the engine's words", async () => {
    const PREFIX = "the server is refusing every request until its configuration is fixed: ";
    for (const [fixture, sentence] of [
      // Refused by the loader (no manifest), its pages cannot leave the index: D39.
      [
        "no-manifest",
        "the index could not be re-aligned with the served pages; nothing is served until the server restarts, and the log has the detail",
      ],
      // Loaded, its pages cannot enter the index: the first load fails.
      ["spec-example", "the index could not take this bundle's pages; the log has the detail"],
    ] as const) {
      const b = box(fixture);
      const own = join(companyDir(b), "bundles", "fixture");
      mkdirSync(own, { recursive: true, mode: 0o700 });
      chmodSync(own, 0o500);
      try {
        const run = rawServer(b);
        run.send(INITIALIZE);
        await run.waitFor(1);
        run.send(INITIALIZED);
        for (const [id, name, args] of [
          [2, "search", { question: "revenue" }],
          [3, "get_page", { path: "index.md" }],
          [4, "status", {}],
        ] as const) {
          run.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
          const answer = await run.waitFor(id);
          // Neither channel names the cache folder, nor carries the file system's words.
          expect(JSON.stringify(answer), `${fixture} ${name}`).not.toContain(b.cacheRoot);
          expect(JSON.stringify(answer), `${fixture} ${name}`).not.toMatch(
            /EACCES|permission denied/,
          );
          const result = answer.result as { isError?: boolean; content: Array<{ text: string }> };
          expect(result.isError, `${fixture} ${name}`).toBe(true);
          expect(result.content[0]?.text, `${fixture} ${name}`).toBe(`${PREFIX}${sentence}`);
        }
        expect((await run.end()).code).toBe(0);
        // The log carries what the model is not told: the folder and the file system's words, under the bundle.
        expect(run.stderr(), fixture).toMatch(/"bundle":"fixture".*EACCES/);
        expect(run.stderr(), fixture).toContain(own);
      } finally {
        chmodSync(own, 0o700);
      }
    }
  });

  // The fold of bite c's build reviews, C-I-A3: git that cannot be prepared refuses the repository bundles alone when
  // the network holds a local bundle, and the network as a whole when every bundle is a repository's.
  it("serves a local bundle while git cannot be prepared, each repository bundle refused alone as load-failed", async () => {
    const fixtures = join(REPO, "test", "fixtures", "bundles");
    const yaml = `network: fixture\nbundles:\n  - id: terms\n    source:\n      local: ${join(fixtures, "behaviours")}\n  - id: remote\n    source:\n      repository: "https://host.example/org/repo.git"\n`;
    const b = box("spec-example", yaml);
    const noGit = mkdtempSync(join(tmpdir(), "okf-catalog-nogit-"));
    b.env.PATH = noGit;
    try {
      const run = rawServer(b);
      run.send(INITIALIZE);
      await run.waitFor(1);
      run.send(INITIALIZED);
      const call = async (id: number, name: string, args: Record<string, unknown>) => {
        run.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
        return (await run.waitFor(id)).result as {
          isError?: boolean;
          content: Array<{ text: string }>;
          structuredContent?: Record<string, unknown>;
        };
      };
      const found = await call(2, "search", { question: "alpha glossary" });
      expect(found.isError).not.toBe(true);
      expect(found.content[0]?.text.split("\n")[0]).toContain("not searched: remote (load-failed)");
      const named = await call(3, "get_page", { path: "index.md", bundle: "remote" });
      expect(named.content[0]?.text).toBe(
        "the bundle remote was refused and nothing in it is served: load-failed: git was not found on PATH; install git 2.30 or later to serve a repository source",
      );
      const status = await call(4, "status", {});
      expect(status.structuredContent?.refusing).toBeNull();
      expect(
        (status.structuredContent as { bundles: Array<{ id: string; state: string }> }).bundles.map(
          (row) => [row.id, row.state],
        ),
      ).toEqual([
        ["terms", "serving"],
        ["remote", "load-failed"],
      ]);
      expect((await run.end()).code).toBe(0);
      expect(run.stderr()).toMatch(/"event":"load.failed","bundle":"remote"/);
    } finally {
      rmSync(noGit, { recursive: true, force: true });
    }
  });

  it("refuses an all-repository network as a whole while git cannot be prepared, and still answers status with its rows", async () => {
    const yaml = `network: fixture\nbundles:\n  - id: one\n    source:\n      repository: "https://host.example/org/one.git"\n  - id: two\n    source:\n      repository: "https://host.example/org/two.git"\n`;
    const b = box("spec-example", yaml);
    const noGit = mkdtempSync(join(tmpdir(), "okf-catalog-nogit-"));
    b.env.PATH = noGit;
    try {
      const run = rawServer(b);
      run.send(INITIALIZE);
      await run.waitFor(1);
      run.send(INITIALIZED);
      run.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search", arguments: { question: "alpha" } },
      });
      const found = (await run.waitFor(2)).result as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(found.isError).toBe(true);
      expect(found.content[0]?.text).toBe(
        "the server is refusing every request until its configuration is fixed: git was not found on PATH; install git 2.30 or later to serve a repository source",
      );
      const status = await statusOver(run, 3);
      expect(status.refusing).toMatch(/^git was not found on PATH/);
      expect(
        (status.bundles as Array<{ id: string; state: string }>).map((row) => [row.id, row.state]),
      ).toEqual([
        ["one", "load-failed"],
        ["two", "load-failed"],
      ]);
      expect((await run.end()).code).toBe(0);
    } finally {
      rmSync(noGit, { recursive: true, force: true });
    }
  });

  it("loads a company: file as a one-bundle network and moves the version 0 cache into bundles/<id>", async () => {
    const repo = packedRepo();
    try {
      const yaml = `company: fixture\nsource:\n  repository: "${repo.url}"\n  branch: published\n`;
      const b = box("spec-example", yaml);
      b.env.OKF_CATALOG_GIT_PROTOCOLS = "file";
      const dir = companyDir(b);
      // A first server writes the network's layout; its clone, link and generation are then put back where a
      // version 0 server kept them, at the root of the folder.
      const first = rawServer(b);
      first.send(INITIALIZE);
      await first.waitFor(1);
      first.send(INITIALIZED);
      const before = await statusOver(first, 2);
      const commit = (before.published as { commit: string }).commit;
      expect((await first.end()).code).toBe(0);
      const own = join(dir, "bundles", "fixture");
      renameSync(join(own, "source"), join(dir, "source"));
      const [generation] = readdirSync(own).filter((n) => n.startsWith("gen-"));
      if (generation === undefined) throw new Error("no generation");
      renameSync(join(own, generation), join(dir, generation));
      symlinkSync(generation, join(dir, "derived"));
      rmSync(join(dir, "bundles"), { recursive: true, force: true });
      // The remote goes away: the moved clone's tree is what the next server answers from (the offline fallback).
      renameSync(join(repo.root, "origin.git"), join(repo.root, "origin.moved"));
      const second = rawServer(b);
      second.send(INITIALIZE);
      await second.waitFor(1);
      second.send(INITIALIZED);
      const after = await statusOver(second, 2);
      // A company: file's status keeps version 0's shape (D74).
      expect(after).toMatchObject({
        company: "fixture",
        source: repo.url,
        admitted: 1,
        lock: "exclusive",
        published: { commit },
      });
      expect(after.network).toBeUndefined();
      second.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_page", arguments: { path: "alpha.md" } },
      });
      expect(JSON.stringify(await second.waitFor(3))).toContain("alpha body");
      expect((await second.end()).code).toBe(0);
      // Under the lock the clone was moved into the bundle's folder, and the root link and generation removed.
      expect(existsSync(join(own, "source", "repo.git", "HEAD"))).toBe(true);
      expect(existsSync(join(dir, "source"))).toBe(false);
      expect(existsSync(join(dir, "derived"))).toBe(false);
      expect(readdirSync(dir).filter((n) => n.startsWith("gen-"))).toEqual([]);
      // The alias is named in the log at start (D-G).
      expect(second.stderr()).toMatch(/"event":"serve.alias"/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  // The fold of bite c's build reviews, C-I-E3: a version 0 file whose company is vendor, dist or build still loads
  // until 0.5.0 (one collection per bundle makes the name harmless, D73), and the log says why it must change.
  it("serves a company: file whose company is vendor, noting at start that a network: file refuses the name", async () => {
    const b = box(
      "spec-example",
      `company: vendor\nsource:\n  local: ${join(REPO, "test", "fixtures", "bundles", "spec-example")}\n`,
    );
    const run = rawServer(b);
    run.send(INITIALIZE);
    await run.waitFor(1);
    run.send(INITIALIZED);
    run.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search", arguments: { question: "revenue recognition" } },
    });
    const found = (await run.waitFor(2)).result as {
      isError?: boolean;
      structuredContent: { hits: Array<{ bundle: string; path: string }> };
    };
    expect(found.isError).not.toBe(true);
    expect(found.structuredContent.hits.map((hit) => [hit.bundle, hit.path])).toContainEqual([
      "vendor",
      "policies/revenue-recognition.md",
    ]);
    expect((await run.end()).code).toBe(0);
    expect(existsSync(join(b.cacheRoot, "okf-catalog", "vendor", "bundles", "vendor"))).toBe(true);
    const notes = run
      .stderr()
      .split("\n")
      .filter((line) => line.includes('"event":"serve.alias"'));
    expect(notes).toHaveLength(2);
    expect(notes[1]).toContain(
      "company: vendor stays the bundle's id until 0.5.0 removes company:; a network: file refuses vendor, dist and build as bundle ids",
    );
  });

  it("removes a version 0 clone the bundle's own clone has replaced, and a link in its place, touching nothing it points at", async () => {
    const repo = packedRepo();
    try {
      const yaml = `company: fixture\nsource:\n  repository: "${repo.url}"\n  branch: published\n`;
      const b = box("spec-example", yaml);
      b.env.OKF_CATALOG_GIT_PROTOCOLS = "file";
      const dir = companyDir(b);
      const once = async (): Promise<ReturnType<typeof rawServer>> => {
        const run = rawServer(b);
        run.send(INITIALIZE);
        await run.waitFor(1);
        run.send(INITIALIZED);
        expect((await statusOver(run, 2)).admitted).toBe(1);
        expect((await run.end()).code).toBe(0);
        return run;
      };
      await once();
      const own = join(dir, "bundles", "fixture", "source", "repo.git", "HEAD");
      expect(existsSync(own)).toBe(true);
      // A version 0 clone beside the bundle's own: the bundle keeps its own, the old one goes.
      mkdirSync(join(dir, "source"), { mode: 0o700 });
      writeFileSync(join(dir, "source", "state.json"), "{}\n");
      const second = await once();
      expect(existsSync(join(dir, "source"))).toBe(false);
      expect(existsSync(own)).toBe(true);
      expect(second.stderr()).toMatch(/"event":"cache.version0".*removed/);
      // A link where the clone was: the link goes, and what it points at stays.
      const outside = mkdtempSync(join(tmpdir(), "okf-catalog-outside-"));
      writeFileSync(join(outside, "keep.txt"), "kept\n");
      symlinkSync(outside, join(dir, "source"));
      await once();
      expect(existsSync(join(dir, "source"))).toBe(false);
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("kept\n");
      rmSync(outside, { recursive: true, force: true });
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  // The fold of bite c's build reviews, C-I-B3, C-I-B4 and C-A-B1: two repository bundles through serve, each with its
  // own clone, its own poller at its own interval, and its source's log records under its own id (D75).
  it("serves two repository bundles, each polled at its own interval and logged under its own id", async () => {
    const first = packedRepo();
    const second = packedRepo();
    const yaml = (one: string, two: string): string =>
      `network: fixture\nbundles:\n  - id: one\n    source:\n      repository: "${one}"\n    serve:\n      pull_interval: 30s\n  - id: two\n    source:\n      repository: "${two}"\n    serve:\n      pull_interval: 2m\n`;
    type Row = {
      id: string;
      state: string;
      poller: { intervalMs: number; lastTick: string | null; lastOutcome: string | null } | null;
    };
    try {
      const b = box("spec-example", yaml(first.url, second.url));
      b.env.OKF_CATALOG_GIT_PROTOCOLS = "file";
      const start = async (): Promise<ReturnType<typeof rawServer>> => {
        const run = rawServer(b);
        run.send(INITIALIZE);
        await run.waitFor(1);
        run.send(INITIALIZED);
        return run;
      };
      // Each bundle clones its own repository into its own folder, and both are searched.
      const online = await start();
      const rows = (await statusOver(online, 2)).bundles as Row[];
      expect(rows.map((row) => [row.id, row.state])).toEqual([
        ["one", "serving"],
        ["two", "serving"],
      ]);
      online.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search", arguments: { question: "alpha" } },
      });
      const found = (await online.waitFor(3)).result as {
        structuredContent: { hits: Array<{ bundle: string }> };
      };
      expect(new Set(found.structuredContent.hits.map((hit) => hit.bundle))).toEqual(
        new Set(["one", "two"]),
      );
      expect((await online.end()).code).toBe(0);
      for (const id of ["one", "two"])
        expect(
          existsSync(join(companyDir(b), "bundles", id, "source", "repo.git", "HEAD")),
          id,
        ).toBe(true);
      // Each bundle names the other's repository now: each source starts over, and says so under its own id.
      writeFileSync(b.configPath, yaml(second.url, first.url));
      const swapped = await start();
      expect(
        ((await statusOver(swapped, 2)).bundles as Row[]).map((row) => [row.id, row.state]),
      ).toEqual([
        ["one", "serving"],
        ["two", "serving"],
      ]);
      expect((await swapped.end()).code).toBe(0);
      for (const id of ["one", "two"])
        expect(swapped.stderr(), id).toMatch(
          new RegExp(`"event":"source.recloned","bundle":"${id}"`),
        );
      // Offline, each bundle answers from its tree on disk and its own poller ticks at once: each tick names its
      // bundle, and each row shows its own poller at its own interval.
      renameSync(join(first.root, "origin.git"), join(first.root, "origin.moved"));
      renameSync(join(second.root, "origin.git"), join(second.root, "origin.moved"));
      const offline = await start();
      const ticked = (id: string): boolean =>
        offline.stderr().includes(`"event":"poller.tick","bundle":"${id}"`);
      const started = Date.now();
      while (!(ticked("one") && ticked("two")) && Date.now() - started < 20_000)
        await new Promise((r) => setTimeout(r, 50));
      expect(ticked("one") && ticked("two")).toBe(true);
      const polled = (await statusOver(offline, 2)).bundles as Row[];
      expect(
        polled.map((row) => [row.id, row.poller?.intervalMs, row.poller?.lastOutcome]),
      ).toEqual([
        ["one", 30_000, "failed"],
        ["two", 120_000, "failed"],
      ]);
      expect((await offline.end()).code).toBe(0);
    } finally {
      rmSync(first.root, { recursive: true, force: true });
      rmSync(second.root, { recursive: true, force: true });
    }
  });

  // The fold of bite c's build reviews, C-I-B2 (D73's "else removed"): a version 0 clone moves only into the one
  // repository bundle of a network that has exactly one, and only when it is a folder; otherwise it is removed.
  it("removes a version 0 clone that no one repository bundle can take, and never moves a link", async () => {
    const planted = '{"planted":"version 0"}\n';
    const serveOnce = async (
      b: Sandbox,
    ): Promise<{ status: Record<string, unknown>; log: string }> => {
      const run = rawServer(b);
      run.send(INITIALIZE);
      await run.waitFor(1);
      run.send(INITIALIZED);
      const status = await statusOver(run, 2);
      expect((await run.end()).code).toBe(0);
      return { status, log: run.stderr() };
    };
    const removed = /"event":"cache.version0","detail":"the version 0 clone was removed/;
    // No repository bundle: a company: file with a local source.
    {
      const b = box("spec-example");
      const dir = companyDir(b);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      plantVersion0(dir);
      const { status, log } = await serveOnce(b);
      expect(status.admitted).toBe(9);
      expect(existsSync(join(dir, "source"))).toBe(false);
      expect(existsSync(join(dir, "derived"))).toBe(false);
      expect(log).toMatch(removed);
    }
    // Two repository bundles: neither takes it.
    const one = packedRepo();
    const two = packedRepo();
    try {
      const b = box(
        "spec-example",
        `network: fixture\nbundles:\n  - id: one\n    source:\n      repository: "${one.url}"\n  - id: two\n    source:\n      repository: "${two.url}"\n`,
      );
      b.env.OKF_CATALOG_GIT_PROTOCOLS = "file";
      const dir = companyDir(b);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      plantVersion0(dir);
      const { status, log } = await serveOnce(b);
      expect(
        (status.bundles as Array<{ id: string; state: string }>).map((row) => [row.id, row.state]),
      ).toEqual([
        ["one", "serving"],
        ["two", "serving"],
      ]);
      expect(existsSync(join(dir, "source"))).toBe(false);
      expect(log).toMatch(removed);
      expect(log).not.toMatch(/moved into the bundle's folder/);
      for (const id of ["one", "two"]) {
        const state = join(dir, "bundles", id, "source", "state.json");
        expect(existsSync(state) ? readFileSync(state, "utf8") : "", id).not.toBe(planted);
      }
    } finally {
      rmSync(one.root, { recursive: true, force: true });
      rmSync(two.root, { recursive: true, force: true });
    }
    // One repository bundle with no clone of its own yet, and a link where the clone was: the link goes, what it
    // points at stays, and the bundle clones into a folder of its own.
    const repo = packedRepo();
    const outside = mkdtempSync(join(tmpdir(), "okf-catalog-outside-"));
    try {
      const b = box(
        "spec-example",
        `company: fixture\nsource:\n  repository: "${repo.url}"\n  branch: published\n`,
      );
      b.env.OKF_CATALOG_GIT_PROTOCOLS = "file";
      const dir = companyDir(b);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(outside, "keep.txt"), "kept\n");
      symlinkSync(outside, join(dir, "source"));
      const { status, log } = await serveOnce(b);
      expect(status.admitted).toBe(1);
      expect(existsSync(join(dir, "source"))).toBe(false);
      expect(lstatSync(join(dir, "bundles", "fixture", "source")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("kept\n");
      expect(log).toMatch(removed);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("leaves the version 0 cache alone in the private fallback", async () => {
    const b = box("spec-example");
    const dir = companyDir(b);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    plantVersion0(dir);
    // Another process holds the network's lock: this one serves from a private folder and moves nothing.
    const holder = spawn(process.execPath, [join(REPO, "test", "helpers", "hold-lock.mjs"), dir], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    try {
      const held = await new Promise<string>((resolve) =>
        holder.stdout?.once("data", (chunk: Buffer) => resolve(chunk.toString().trim())),
      );
      expect(held).toBe("exclusive");
      const run = rawServer(b);
      run.send(INITIALIZE);
      await run.waitFor(1);
      run.send(INITIALIZED);
      const status = await statusOver(run, 2);
      expect(status.lock).toBe("private");
      expect(status.admitted).toBe(9);
      expect((await run.end()).code).toBe(0);
      expect(readFileSync(join(dir, "source", "state.json"), "utf8")).toBe(
        '{"planted":"version 0"}\n',
      );
      expect(readlinkSync(join(dir, "derived"))).toBe("gen-1-1-1");
      expect(existsSync(join(dir, "gen-1-1-1", "page.md"))).toBe(true);
      expect(existsSync(join(dir, "bundles"))).toBe(false);
    } finally {
      holder.stdin?.end();
      holder.kill();
    }
  });
});
