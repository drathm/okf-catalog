#!/usr/bin/env node
// The server pre-check for the acceptance questions: drives the built server over stdio through the SDK
// client with the configuration given, asks each question through `search` (the question text, then the
// keywords when the question carries them), prints the expected page's rank, the top hit's path, trust tier,
// verifier and recheck date, and the expected page's header from `get_page`, and exits 1 when an expected
// page is absent from the hits of every form asked. Evidence for the server, not for the model: items 2 to 4
// of the acceptance list are judged on Claude Code's answers (claude.sh and verify.mjs).
// Usage: node bench/acceptance/ask.mjs --config <okf-catalog.yaml> --questions <file> [--limit 8]
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const configPath = option("--config");
const questionsPath = option("--questions");
const limit = Number(option("--limit") ?? 8);
if (configPath === undefined || questionsPath === undefined) {
  process.stderr.write(
    "usage: node bench/acceptance/ask.mjs --config <yaml> --questions <file> [--limit 8]\n",
  );
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "..", "dist", "cli.js");
const questions = JSON.parse(readFileSync(questionsPath, "utf8"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, "serve", "--config", resolve(configPath), "--log-level", "warn"],
  env: { ...process.env, NODE_LLAMA_CPP_SKIP_DOWNLOAD: "1" },
  stderr: "inherit",
});
const client = new Client({ name: "okf-catalog-acceptance", version: "0" });
await client.connect(transport);
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) throw new Error(`${name}: ${result.content?.[0]?.text ?? "error"}`);
  return result.structuredContent;
};
const verifierOf = (v) =>
  v === undefined || v === null ? "-" : `${v.by}${v.at ? ` at ${v.at}` : ""}`;
let failures = 0;
for (const q of questions) {
  const forms = [["question", q.question]];
  if (Array.isArray(q.keywords) && q.keywords.length > 0)
    forms.push(["keywords", q.keywords.join(" ")]);
  const ranks = [];
  let top;
  for (const [form, text] of forms) {
    let out;
    try {
      out = await call("search", { question: text, limit, freshness: "any" });
    } catch (error) {
      ranks.push(`${form}: absent (${error.message.replace(/^search: /, "")})`);
      continue;
    }
    const position = out.hits.findIndex((h) => h.path === q.gold);
    ranks.push(
      `${form}: ${position === -1 ? "absent" : `rank ${position + 1}`} of ${out.hits.length} hits`,
    );
    if (top === undefined) top = out.hits[0];
  }
  const found = ranks.some((r) => r.includes("rank"));
  if (!found) failures += 1;
  process.stdout.write(
    `${q.id} (${q.style}${q.bodyOnly ? ", body only" : ""}): ${ranks.join("; ")}${found ? "" : "  <-- expected page not among the hits"}\n`,
  );
  if (top !== undefined) {
    process.stdout.write(
      `  top hit: ${top.path}, trust ${top.trust}, recheck ${top.recheck?.raw ?? "-"}${top.recheck?.overdue ? " (overdue)" : ""}\n`,
    );
  }
  try {
    const page = await call("get_page", { path: q.gold });
    const header = page.header ?? page.provenance ?? page;
    process.stdout.write(
      `  expected page: ${header.path}, type ${header.type}, status ${header.status}, trust ${header.trust}, verifier ${verifierOf(header.latestVerification)}, recheck ${header.staleAfter?.raw ?? "-"}\n`,
    );
  } catch (error) {
    process.stdout.write(`  expected page: ${error.message}\n`);
  }
}
await client.close();
process.stdout.write(
  `${questions.length - failures} of ${questions.length} expected pages found\n`,
);
process.exit(failures === 0 ? 0 : 1);
