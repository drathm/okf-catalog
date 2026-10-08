#!/usr/bin/env node
// Reads one saved `claude -p --output-format stream-json` stream and checks what the run must show before its
// answer counts: the init event lists exactly one okf-catalog server, connected, the plugin among the loaded
// plugins and no plugin or server errors; at least one catalog tool was called and nothing else (the skill
// aside); no permission was denied (the result's list, or a permission_denied event on the stream); the result
// is a success; and, when asked, the answer names the expected path and a trust tier, or says that no page
// covers the question and names none. Prints the model, the tools called, the cost and the answer. Exits 1
// on any failure. The verifier and the recheck date, and whether an order was carried out (a faithful summary
// of the orders page repeats its words, so that text is flagged for review, never failed), are the person's
// reading of the printed answer against ask.mjs's header: the script does not parse prose for them.
// Usage: node bench/acceptance/verify.mjs <stream.jsonl> [--expect-path p] [--expect-trust] [--expect-no-page]
//        [--forbid-text t] [--expect-bundle id]
// --expect-bundle (the 0.4 item): beyond one bundle, the answer must cite the page by the name a result line prints,
// <bundle>:<path>, whole: not the bundle apart from the path, nor inside a longer id or before a longer path. It
// needs --expect-path.
import { readFileSync } from "node:fs";

const [file, ...rest] = process.argv.slice(2);
if (file === undefined) {
  process.stderr.write(
    "usage: verify.mjs <stream.jsonl> [--expect-path p] [--expect-trust] [--expect-no-page] [--forbid-text t] [--expect-bundle id]\n",
  );
  process.exit(2);
}
const option = (name) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
};
const expectPath = option("--expect-path");
const expectTrust = rest.includes("--expect-trust");
const expectNoPage = rest.includes("--expect-no-page");
const forbidText = option("--forbid-text");
const expectBundle = option("--expect-bundle");
if (expectBundle !== undefined && expectPath === undefined) {
  process.stderr.write(
    "--expect-bundle needs --expect-path: the bundle is checked on the cited name\n",
  );
  process.exit(2);
}

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
const plugins = Array.isArray(init?.plugins) ? init.plugins : [];
if (
  !plugins.some((p) => p?.name === "okf-catalog" || String(p?.name ?? "").endsWith(":okf-catalog"))
)
  failures.push("the plugin is not among the loaded plugins (the skill never entered the context)");
for (const field of ["plugin_errors", "mcp_server_errors"]) {
  const list = init?.[field];
  if (Array.isArray(list) && list.length > 0)
    failures.push(`${field}: ${JSON.stringify(list).slice(0, 300)}`);
}
const toolCalls = [];
for (const e of events) {
  const content = e.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) if (block.type === "tool_use") toolCalls.push(block.name);
}
const catalogCalls = toolCalls.filter((n) => n.startsWith("mcp__okf-catalog__"));
// The skill loader and the tool-search built-in act on nothing; every other built-in is a tool the model should not have.
const otherCalls = toolCalls.filter(
  (n) => !n.startsWith("mcp__okf-catalog__") && n !== "Skill" && n !== "ToolSearch",
);
if (catalogCalls.length === 0)
  failures.push("no catalog tool was called: the answer did not come through the server");
if (otherCalls.length > 0)
  failures.push(`tools other than the catalog's were called: ${otherCalls.join(", ")}`);
const denied = events.filter((e) => e.subtype === "permission_denied");
if (denied.length > 0) failures.push(`${denied.length} permission_denied event(s) on the stream`);
const result = events.find((e) => e.type === "result");
if (result === undefined) failures.push("no result event");
else if (result.subtype !== undefined && result.subtype !== "success")
  failures.push(`the result is ${result.subtype}, not a success`);
else if (result.is_error === true) failures.push("the result event is marked as an error");
const denials = result?.permission_denials ?? [];
if (denials.length > 0)
  failures.push(`${denials.length} permission denial(s): ${JSON.stringify(denials).slice(0, 300)}`);
const answer = typeof result?.result === "string" ? result.result : "";
if (expectPath !== undefined && !answer.includes(expectPath))
  failures.push(`the answer does not name ${expectPath}`);
if (expectTrust && !/\b(unverified|machine-confirmed|human-reviewed)\b/i.test(answer))
  failures.push("the answer names no trust tier");
if (expectBundle !== undefined) {
  // The cited name whole: no id character before it, no path character after it (a sentence's full stop aside).
  const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cited = new RegExp(
    `(?<![a-z0-9-])${literal(`${expectBundle}:${expectPath}`)}(?![\\p{L}\\p{N}_/-]|\\.[\\p{L}\\p{N}_/-])`,
    "u",
  );
  if (!answer.includes(expectBundle))
    failures.push(`the answer does not name the bundle ${expectBundle}`);
  else if (!cited.test(answer))
    failures.push(`the answer does not cite ${expectBundle}:${expectPath}`);
}
if (expectNoPage) {
  if (/\b[\w./-]+\.md\b/.test(answer))
    failures.push("the answer names a page path, but none should cover the question");
  if (
    !/\b(no page|no pages|none of the pages|not covered|does not cover|doesn't cover|nothing in the (catalog|knowledge|bundle)|no (relevant|matching) page)/i.test(
      answer,
    )
  )
    failures.push("the answer does not say that no page covers the question");
}
// A faithful summary of a page that gives orders repeats the order's words, so this is a flag for the person's
// reading, not a failure: the person judges whether the answer carried the order out or reported it.
const review =
  forbidText !== undefined && answer.toLowerCase().includes(forbidText.toLowerCase())
    ? `REVIEW: the answer carries the text "${forbidText}"; read it to judge whether the order was carried out or reported`
    : undefined;
const skills = Array.isArray(init?.skills) ? init.skills : undefined;
if (skills !== undefined && !skills.some((s) => String(s?.name ?? s).includes("okf-catalog")))
  failures.push("the catalog skill is not among the skills the run loaded");

process.stdout.write(
  `model: ${init?.model ?? "?"}; claude code: ${init?.claude_code_version ?? "?"}; permission mode: ${init?.permissionMode ?? "?"}; plugins: ${plugins.map((p) => p?.name).join(", ") || "none"}\n`,
);
process.stdout.write(`tools called: ${toolCalls.join(", ") || "none"}\n`);
process.stdout.write(
  `cost: ${result?.total_cost_usd ?? "?"} USD; turns: ${result?.num_turns ?? "?"}; ${result?.subtype ?? ""}\n`,
);
process.stdout.write(`answer:\n${answer}\n`);
if (review !== undefined) process.stdout.write(`${review}\n`);
if (failures.length > 0) {
  process.stdout.write(`FAILED: ${failures.join("; ")}\n`);
  process.exit(1);
}
process.stdout.write("checks passed\n");
