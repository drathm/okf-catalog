#!/usr/bin/env node
// Acceptance item 5, the server's side: drives the built server over stdio through the SDK client with the
// configuration given, reports the published commit it serves, asks `search` the question and reads the page,
// then waits for the poller to pick up a newer published commit (`--until-change`, at most `--intervals`
// poll intervals) and asks again. Evidence for the server, not for the model: whether an agent answers from the
// new text is judged on Claude Code's answers (claude.sh). Exit 1 when the change does not arrive in time.
// Usage: node bench/acceptance/publish-watch.mjs --config <okf-catalog.yaml> --question <text> --page <path>
//        [--until-change] [--intervals 2] [--interval-ms 30000]
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
const question = option("--question");
const page = option("--page");
const untilChange = argv.includes("--until-change");
const intervals = Number(option("--intervals") ?? 2);
const intervalMs = Number(option("--interval-ms") ?? 30_000);
if (configPath === undefined || question === undefined || page === undefined) {
  process.stderr.write(
    "usage: node bench/acceptance/publish-watch.mjs --config <yaml> --question <text> --page <path> [--until-change] [--intervals 2] [--interval-ms 30000]\n",
  );
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "..", "dist", "cli.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, "serve", "--config", resolve(configPath), "--log-level", "warn"],
  env: { ...process.env, NODE_LLAMA_CPP_SKIP_DOWNLOAD: "1" },
  stderr: "inherit",
});
const client = new Client({ name: "okf-catalog-publish-watch", version: "0" });
await client.connect(transport);

const stamp = () => new Date().toISOString().slice(11, 19);
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { text, data: result.structuredContent, isError: result.isError === true };
};
const status = async () => {
  const s = (await call("status", {})).data;
  return {
    commit: s?.published?.commit ?? null,
    fetchedAt: s?.published?.fetchedAt ?? null,
    admitted: s?.admitted,
    poller: s?.poller ?? null,
  };
};
const ask = async (label) => {
  const found = await call("search", { question, limit: 5 });
  const hits = (found.data?.hits ?? []).map((h) => `${h.path} [${h.trust ?? h.tier ?? "?"}]`);
  const read = await call("get_page", { path: page });
  const firstLines = read.text.split("\n").slice(0, 12).join("\n");
  process.stdout.write(
    `\n[${stamp()}] ${label}\n  search "${question}": ${hits.length ? hits.join(", ") : "no hits"}\n  get_page ${page}: ${read.isError ? "ERROR " : ""}${firstLines.replace(/\n/g, "\n    ")}\n`,
  );
};

const before = await status();
process.stdout.write(
  `[${stamp()}] serving published commit ${before.commit ?? "none"} (fetched ${before.fetchedAt}); ${before.admitted} pages admitted; poll every ${before.poller?.intervalMs ?? "?"} ms\n`,
);
await ask("before");

let exit = 0;
if (untilChange) {
  const deadline = Date.now() + intervals * intervalMs + 5_000;
  let now = before;
  while (now.commit === before.commit && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    now = await status();
  }
  if (now.commit === before.commit) {
    process.stdout.write(
      `[${stamp()}] no new published commit within ${intervals} intervals (last tick ${now.poller?.lastTick}, outcome ${now.poller?.lastOutcome})\n`,
    );
    exit = 1;
  } else {
    process.stdout.write(
      `[${stamp()}] picked up ${now.commit} (fetched ${now.fetchedAt}; last tick ${now.poller?.lastTick}, outcome ${now.poller?.lastOutcome}); ${now.admitted} pages admitted\n`,
    );
    await ask("after");
  }
}
await client.close();
process.exit(exit);
