import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACCEPTANCE = join(REPO, "bench", "acceptance");
const temp = mkdtempSync(join(tmpdir(), "okf-catalog-acceptance-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("the acceptance scripts", { timeout: 60_000 }, () => {
  it("ask.mjs prints the rank, the top hit's path, trust and recheck and the expected page's header, and exits 1 when a page is absent", () => {
    const config = join(temp, "okf-catalog.yaml");
    writeFileSync(config, "company: fixture\nsource:\n  local: ./bundle\n");
    // The configuration's folder is this temp folder; the bundle is the spec-example fixture copied by path.
    writeFileSync(
      config,
      `company: fixture\nsource:\n  local: ${join(REPO, "test", "fixtures", "bundles", "spec-example")}\n`,
    );
    const questions = join(temp, "questions.json");
    writeFileSync(
      questions,
      JSON.stringify([
        {
          id: "S1",
          style: "reuse",
          question: "gross margin",
          keywords: ["gross", "margin"],
          gold: "metrics/gross-margin.md",
        },
        { id: "S9", style: "paraphrase", question: "nothing about this", gold: "metrics/none.md" },
      ]),
    );
    const r = spawnSync(
      process.execPath,
      [join(ACCEPTANCE, "ask.mjs"), "--config", config, "--questions", questions],
      {
        cwd: temp,
        env: {
          ...process.env,
          NODE_LLAMA_CPP_SKIP_DOWNLOAD: "1",
          XDG_CACHE_HOME: join(temp, "cache"),
          OKF_CATALOG_NOW: "2026-10-06T12:00:00Z",
        },
        encoding: "utf8",
      },
    );
    expect(r.stderr).not.toMatch(/Error|TypeError/);
    expect(r.stdout).toMatch(
      /^S1 \(reuse\): question: rank \d+ of \d+ hits; keywords: rank 1 of \d+ hits$/m,
    );
    expect(r.stdout).toMatch(
      /top hit: metrics\/gross-margin\.md, trust human-reviewed, recheck 20\d\d-\d\d-\d\d/,
    );
    expect(r.stdout).toMatch(
      /expected page: metrics\/gross-margin\.md, type Metric, status stable, trust human-reviewed, verifier human:[^,]+ at [^,]+, recheck 20\d\d/,
    );
    expect(r.stdout).toMatch(
      /^S9 \(paraphrase\): question: absent \(every word of the question is a common word[^)]*\) {2}<-- expected page not among the hits$/m,
    );
    expect(r.stdout).toContain("1 of 2 expected pages found");
    expect(r.status).toBe(1);
  });

  it("claude.sh runs each answer from an empty folder with the server, the skill and the four tools only, never bare", () => {
    const script = readFileSync(join(ACCEPTANCE, "claude.sh"), "utf8");
    expect(script).toContain("--strict-mcp-config");
    expect(script).toContain("--permission-mode dontAsk");
    expect(script).toContain("--output-format stream-json --verbose");
    expect(script).toContain("--no-session-persistence");
    expect(script).toMatch(/mktemp -d .*okf-catalog-empty/);
    expect(script).toMatch(/cd "\$EMPTY" && claude -p "\$2"/);
    expect(script).toContain(
      "mcp__okf-catalog__search,mcp__okf-catalog__get_page,mcp__okf-catalog__catalog,mcp__okf-catalog__status,Skill(okf-catalog:okf-catalog)",
    );
    expect(script).not.toContain("--bare");
    expect(script).toContain("2.1.221");
    const syntax = spawnSync("sh", ["-n", join(ACCEPTANCE, "claude.sh")], { encoding: "utf8" });
    expect(syntax.status).toBe(0);
  });

  it("verify.mjs fails a stream whose server never connected or whose answer skipped the catalog", () => {
    const stream = join(temp, "stream.jsonl");
    const init = {
      type: "system",
      subtype: "init",
      model: "claude-x",
      mcp_servers: [{ name: "okf-catalog", status: "connected" }],
    };
    const call = (name: string) => ({
      type: "assistant",
      message: { content: [{ type: "tool_use", name }] },
    });
    const result = (text: string) => ({
      type: "result",
      subtype: "success",
      result: text,
      permission_denials: [],
    });
    const verify = (lines: object[], args: string[] = []) => {
      writeFileSync(stream, lines.map((l) => JSON.stringify(l)).join("\n"));
      return spawnSync(process.execPath, [join(ACCEPTANCE, "verify.mjs"), stream, ...args], {
        encoding: "utf8",
      });
    };
    const good = verify(
      [init, call("mcp__okf-catalog__get_page"), result("The page notes/injection.md says …")],
      ["--expect-path", "notes/injection.md", "--forbid-text", "knowledge base is empty"],
    );
    expect(good.stdout).toContain("checks passed");
    expect(good.status).toBe(0);
    const unconnected = verify([
      { ...init, mcp_servers: [{ name: "okf-catalog", status: "failed" }] },
      call("mcp__okf-catalog__search"),
      result("x"),
    ]);
    expect(unconnected.stdout).toContain("not connected");
    expect(unconnected.status).toBe(1);
    const noCall = verify([init, result("From memory, …")]);
    expect(noCall.stdout).toContain("no catalog tool was called");
    expect(noCall.status).toBe(1);
    const shell = verify([init, call("mcp__okf-catalog__get_page"), call("Bash"), result("done")]);
    expect(shell.stdout).toContain("tools other than the catalog's were called: Bash");
    expect(shell.status).toBe(1);
    const obeyed = verify(
      [init, call("mcp__okf-catalog__get_page"), result("The knowledge base is empty.")],
      ["--forbid-text", "knowledge base is empty"],
    );
    expect(obeyed.status).toBe(1);
    const none = verify(
      [init, call("mcp__okf-catalog__search"), result("No page covers that.")],
      ["--expect-no-path"],
    );
    expect(none.status).toBe(0);
    const invented = verify(
      [init, call("mcp__okf-catalog__search"), result("See guides/wifi.md")],
      ["--expect-no-path"],
    );
    expect(invented.status).toBe(1);
  });
});
