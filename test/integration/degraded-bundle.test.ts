import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { CLI, REPO, type Sandbox, sandbox } from "../helpers/stdio.js";

// Specification §11: a bundle with no index files, an unknown type and a broken link loads, is served and is
// reported, never refused. Served the way a company serves one: the built binary, the real engine, a manifest,
// declared types, development mode off.

let box: Sandbox | undefined;
afterEach(() => box?.dispose());

describe("a degraded bundle over stdio", { timeout: 60_000 }, () => {
  it("loads, is served and is reported: no index files, an unknown type and a broken link, with nothing refused", async () => {
    box = sandbox("spec-example");
    const bundle = join(box.root, "kb");
    // The same writer the person's runbook uses, so the test and the manual run serve the same bundle.
    execFileSync(
      process.execPath,
      [join(REPO, "bench", "acceptance", "write-degraded-bundle.mjs"), bundle],
      {
        stdio: "ignore",
      },
    );
    writeFileSync(
      box.configPath,
      `company: fixture\nsource:\n  local: ${bundle}\ntypes: [Term, Guide]\n`,
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "serve", "--config", box.configPath],
      env: box.env,
      cwd: box.cwd,
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ text?: string }>;
        structuredContent: Record<string, unknown>;
      };
      expect(result.isError, result.content[0]?.text).not.toBe(true);
      return result;
    };

    const status = await call("status", {});
    const s = status.structuredContent as {
      admitted: number;
      integrity: string;
      fatal: unknown;
      refusals: { count: number; first: unknown[] };
      unknownTypes: { count: number; first: string[] };
      brokenLinks: { count: number; first: Array<{ from: string; raw: string }> };
      foldersWithoutIndex: { count: number; first: string[] };
    };
    expect(s.fatal).toBeNull();
    expect(s.admitted).toBe(3);
    expect(s.integrity).toBe("checked");
    expect(s.refusals.count).toBe(0);
    expect(s.unknownTypes.first).toEqual(["Recipe"]);
    expect(s.brokenLinks.first).toEqual([{ from: "terms/alpha.md", raw: "/terms/missing.md" }]);
    expect(s.foldersWithoutIndex.first).toEqual(expect.arrayContaining(["guides", "terms"]));

    const search = await call("search", { question: "zanzibar" });
    const hits = (search.structuredContent as { hits: Array<{ path: string; type: string }> }).hits;
    expect(hits[0]?.path).toBe("terms/beta.md");
    expect(hits[0]?.type).toBe("Recipe");

    const page = await call("get_page", { path: "terms/beta.md" });
    // An undeclared type is the company's own text, quoted in the header (P13).
    expect(page.content[0]?.text).toContain('terms/beta.md ["Recipe", stable, unverified');
    expect(page.content[0]?.text).toContain("never declared");

    const catalog = await call("catalog", { folder: "terms" });
    const entries = (
      catalog.structuredContent as { entries: Array<{ path: string }>; source: string }
    ).entries;
    expect(entries.map((e) => e.path).sort()).toEqual(["terms/alpha.md", "terms/beta.md"]);
    expect((catalog.structuredContent as { source: string }).source).toBe("generated");
    await client.close();

    // The same folder through `check`, as a company would run it on a checkout.
    const check = execFileSync(
      process.execPath,
      [CLI, "check", bundle, "--integrity", "none", "--types", "Term,Guide", "--json"],
      { env: box.env, encoding: "utf8" },
    );
    const report = JSON.parse(check) as {
      fatal?: unknown;
      unknownTypes: string[];
      brokenLinks: unknown[];
      foldersWithoutIndex: string[];
    };
    expect(report.fatal ?? null).toBeNull();
    expect(report.unknownTypes).toEqual(["Recipe"]);
    expect(report.brokenLinks).toHaveLength(1);
    expect(report.foldersWithoutIndex).toEqual(expect.arrayContaining(["guides", "terms"]));
  });
});
