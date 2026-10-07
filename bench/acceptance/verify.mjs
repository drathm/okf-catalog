#!/usr/bin/env node
// Reads one saved `claude -p --output-format stream-json` stream and checks what the run must show before its
// answer counts: the init event lists exactly one okf-catalog server, connected; at least one catalog tool
// was called and nothing else (the skill aside); no permission was denied; and, when asked, the answer names
// a path or names none. Prints the model, the tools called, the cost and the answer. Exits 1 on any failure.
// Usage: node bench/acceptance/verify.mjs <stream.jsonl> [--expect-path p] [--expect-no-path] [--forbid-text t]
import { readFileSync } from "node:fs";

const [file, ...rest] = process.argv.slice(2);
if (file === undefined) {
  process.stderr.write(
    "usage: verify.mjs <stream.jsonl> [--expect-path p] [--expect-no-path] [--forbid-text t]\n",
  );
  process.exit(2);
}
const option = (name) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
};
const expectPath = option("--expect-path");
const expectNoPath = rest.includes("--expect-no-path");
const forbidText = option("--forbid-text");

const events = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const failures = [];
const init = events.find((e) => e.type === "system" && e.subtype === "init");
if (init === undefined) failures.push("no system/init event: the run did not start");
const servers = (init?.mcp_servers ?? []).filter((s) => s.name === "okf-catalog");
if (servers.length !== 1)
  failures.push(`${servers.length} okf-catalog servers listed, expected exactly one`);
else if (servers[0].status !== "connected")
  failures.push(`the okf-catalog server is ${servers[0].status}, not connected`);
const plugins = init?.plugins;
if (Array.isArray(plugins) && !plugins.some((p) => JSON.stringify(p).includes("okf-catalog")))
  failures.push("the plugin is not among the loaded plugins");
const toolCalls = [];
for (const e of events) {
  const content = e.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) if (block.type === "tool_use") toolCalls.push(block.name);
}
const catalogCalls = toolCalls.filter((n) => n.startsWith("mcp__okf-catalog__"));
const otherCalls = toolCalls.filter((n) => !n.startsWith("mcp__okf-catalog__") && n !== "Skill");
if (catalogCalls.length === 0)
  failures.push("no catalog tool was called: the answer did not come through the server");
if (otherCalls.length > 0)
  failures.push(`tools other than the catalog's were called: ${otherCalls.join(", ")}`);
const result = events.find((e) => e.type === "result");
if (result === undefined) failures.push("no result event");
const denials = result?.permission_denials ?? [];
if (denials.length > 0)
  failures.push(`${denials.length} permission denial(s): ${JSON.stringify(denials).slice(0, 300)}`);
const answer = typeof result?.result === "string" ? result.result : "";
if (expectPath !== undefined && !answer.includes(expectPath))
  failures.push(`the answer does not name ${expectPath}`);
if (expectNoPath && /\b[\w./-]+\.md\b/.test(answer))
  failures.push("the answer names a page path, but none should cover the question");
if (forbidText !== undefined && answer.toLowerCase().includes(forbidText.toLowerCase()))
  failures.push(`the answer carries the forbidden text "${forbidText}"`);

process.stdout.write(
  `model: ${init?.model ?? "?"}; claude code: ${init?.claude_code_version ?? "?"}; permission mode: ${init?.permissionMode ?? "?"}\n`,
);
process.stdout.write(`tools called: ${toolCalls.join(", ") || "none"}\n`);
process.stdout.write(
  `cost: ${result?.total_cost_usd ?? "?"} USD; turns: ${result?.num_turns ?? "?"}; ${result?.subtype ?? ""}\n`,
);
process.stdout.write(`answer:\n${answer}\n`);
if (failures.length > 0) {
  process.stdout.write(`FAILED: ${failures.join("; ")}\n`);
  process.exit(1);
}
process.stdout.write("checks passed\n");
