import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
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

describe("okf-catalog serve over stdio", { timeout: 60_000 }, () => {
  it("serves the four tools to the SDK client, with the private cache under the sandbox and stderr piped", async () => {
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
    expect(tools).toEqual(["catalog", "get_page", "search", "status"]);
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
    expect((list.result as { tools: unknown[] }).tools).toHaveLength(4);
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
    expect((list.result as { tools: unknown[] }).tools).toHaveLength(4);
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
    expect(tools).toEqual(["catalog", "get_page", "search", "status"]);
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
      expect(existsSync(join(companyDir(b), "source", "repo.git", "HEAD"))).toBe(true);
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
        existsSync(join(companyDir(b), "private", pid, "source", "repo.git", "HEAD")),
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
