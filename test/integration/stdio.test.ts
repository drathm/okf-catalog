import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock } from "../../src/fs/company-lock.js";
import {
  CLI,
  INITIALIZE,
  INITIALIZED,
  impureLines,
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
    expect(run.stderr()).toMatch(/"event":"serve.shutdown"/);
    // The lock is free again and no private folder was left behind.
    const lock = acquireLock(companyDir(b), new Date());
    expect(lock.kind).toBe("exclusive");
    if (lock.kind === "exclusive") lock.close();
    expect(existsSync(join(companyDir(b), "private"))).toBe(false);
  });

  it("the purity assertion fails on a server that leaks to stdout (negative control)", async () => {
    const b = box();
    const run = rawServer(
      b,
      [],
      ["--import", join(import.meta.dirname, "..", "helpers", "noisy-import.mjs")],
    );
    run.send(INITIALIZE);
    await run.waitFor(1);
    await new Promise((r) => setTimeout(r, 200));
    await run.end();
    expect(impureLines(run.stdout()).length).toBeGreaterThan(0);
  });

  it("survives SIGTERM during the first load and leaves a cache the next run can use", async () => {
    const b = box();
    const run = rawServer(b);
    run.send(INITIALIZE);
    run.child.kill("SIGTERM");
    const exit = await run.end();
    expect([0, null]).toContain(exit.code);
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
    expect(JSON.stringify(status)).toContain('"admitted":9');
    await again.end();
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
});
