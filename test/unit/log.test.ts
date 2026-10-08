import { describe, expect, it } from "vitest";
import { createLog } from "../../src/log.js";

function sink() {
  const lines: string[] = [];
  return { lines, write: (s: string) => lines.push(s) };
}

describe("createLog", () => {
  it("writes one JSON object per line with time, level and event, above the threshold only", () => {
    const out = sink();
    const log = createLog(out, "info", () => new Date("2026-10-07T00:00:00Z"));
    log.debug("serve.start", {});
    log.info("serve.start", { company: "acme" });
    log.error("load.fatal", { rule: "manifest-missing", path: "manifest.json" });
    expect(out.lines).toHaveLength(2);
    expect(JSON.parse(out.lines[0] ?? "")).toEqual({
      time: "2026-10-07T00:00:00.000Z",
      level: "info",
      event: "serve.start",
      company: "acme",
    });
    expect(JSON.parse(out.lines[1] ?? "")).toMatchObject({
      level: "error",
      event: "load.fatal",
      rule: "manifest-missing",
    });
    for (const line of out.lines) expect(line.endsWith("\n")).toBe(true);
  });

  it("drops fields outside an event's allowlist, so a question or a body can never reach the log", () => {
    const out = sink();
    const log = createLog(out, "debug", () => new Date(0));
    log.info("tool.call", {
      tool: "search",
      ms: 12,
      hits: 3,
      engineQueries: 4,
      rowsFetched: 40,
      question: "secret text",
      body: "page text",
      title: "t",
    } as never);
    const record = JSON.parse(out.lines[0] ?? "{}") as Record<string, unknown>;
    expect(record).toEqual({
      time: "1970-01-01T00:00:00.000Z",
      level: "info",
      event: "tool.call",
      tool: "search",
      ms: 12,
      hits: 3,
      engineQueries: 4,
      rowsFetched: 40,
    });
    expect(JSON.stringify(out.lines)).not.toMatch(/secret text|page text/);
  });

  it("writes the warning of an admitted word that matches no page with its word (D77)", () => {
    const out = sink();
    const log = createLog(out, "info", () => new Date(0));
    log.warn("serve.admit", { word: "depreciated", detail: "matches no page" });
    expect(JSON.parse(out.lines[0] ?? "{}")).toEqual({
      time: "1970-01-01T00:00:00.000Z",
      level: "warn",
      event: "serve.admit",
      word: "depreciated",
      detail: "matches no page",
    });
  });

  it("escapes control characters inside string fields", () => {
    const out = sink();
    const log = createLog(out, "info", () => new Date(0));
    log.error("load.fatal", { rule: "no-type", path: "evil\u001b[2K\npage.md" });
    expect(out.lines[0]).not.toContain(String.fromCodePoint(0x1b));
    expect(out.lines[0]?.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
  });
});
