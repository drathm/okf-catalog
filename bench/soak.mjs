#!/usr/bin/env node
// A soak of the serving loop: a published branch in a local bare repository, one server over stdio polled at the
// shortest interval, and a publish every cycle (a page changed, packed, pushed). Each cycle waits for the server
// to serve the new commit and records the server's resident memory, the time to pick the change up, and the
// counts from status. Usage: node bench/soak.mjs [--cycles 20] [--interval 30s] [--out <folder>]
// Writes <out>/soak-<stamp>.json and prints a summary; leaves nothing behind but that file.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const cycles = Number(option("--cycles", "20"));
const interval = option("--interval", "30s");
const outDir = option("--out", join(here, "results"));
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const work = mkdtempSync(join(tmpdir(), "okf-catalog-soak-"));
const env = {
  ...process.env,
  NODE_LLAMA_CPP_SKIP_DOWNLOAD: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "soak",
  GIT_AUTHOR_EMAIL: "soak@example.invalid",
  GIT_COMMITTER_NAME: "soak",
  GIT_COMMITTER_EMAIL: "soak@example.invalid",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The source bundle: the specification's example, with one page we change every cycle.
const source = join(work, "source");
execFileSync("cp", ["-R", join(repo, "test", "fixtures", "bundles", "spec-example"), source]);
rmSync(join(source, "manifest.json"), { force: true });
const changing = join(source, "metrics", "revenue.md");
const original = readFileSync(changing, "utf8");
const config = join(work, "pack.yaml");
writeFileSync(config, `company: soak\nsource:\n  local: ./source\n`);
const publishing = join(work, "publishing");
git(work, "init", "-q", "-b", "published", publishing);
const bare = join(work, "origin.git");
git(work, "init", "-q", "--bare", bare);
git(publishing, "remote", "add", "origin", bare);
const publish = (cycle) => {
  writeFileSync(
    changing,
    `${original}\nSoak cycle ${cycle}: the revenue page changed at ${new Date().toISOString()}.\n`,
  );
  const out = join(work, `packed-${cycle}`);
  const r = spawnSync(
    process.execPath,
    [join(repo, "dist", "cli.js"), "pack", "--config", config, "--from", source, "--out", out],
    { env, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`pack failed: ${r.stderr}`);
  for (const entry of execFileSync("ls", ["-A", publishing], { encoding: "utf8" })
    .split("\n")
    .filter((n) => n && n !== ".git"))
    rmSync(join(publishing, entry), { recursive: true, force: true });
  execFileSync("sh", ["-c", `cp -R "${out}/." "${publishing}/"`]);
  rmSync(out, { recursive: true, force: true });
  git(publishing, "add", "-A");
  git(publishing, "commit", "-q", "-m", `soak ${cycle}`);
  git(publishing, "push", "-q", "origin", "published");
  return git(publishing, "rev-parse", "HEAD");
};

const first = publish(0);
const serveConfig = join(work, "okf-catalog.yaml");
writeFileSync(
  serveConfig,
  `company: soak\nsource:\n  repository: "file://${bare}"\n  branch: published\nserve:\n  pull_interval: ${interval}\n`,
);
const cache = join(work, "cache");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repo, "dist", "cli.js"), "serve", "--config", serveConfig, "--log-level", "warn"],
  env: { ...env, XDG_CACHE_HOME: cache, OKF_CATALOG_GIT_PROTOCOLS: "file" },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (c) => {
  stderr += c.toString();
});
const client = new Client({ name: "soak", version: "0" });
await client.connect(transport);
const pid = transport.pid;
const status = async () =>
  (await client.callTool({ name: "status", arguments: {} })).structuredContent;
const rssKiB = () =>
  Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
const rows = [];
const started = Date.now();
let s = await status();
if (s.published?.commit !== first)
  throw new Error(`first load served ${s.published?.commit}, expected ${first}`);
rows.push({
  cycle: 0,
  commit: first,
  pickupMs: 0,
  rssKiB: rssKiB(),
  admitted: s.admitted,
  documents: s.engine?.documents,
});
process.stdout.write(`cycle 0: served ${first.slice(0, 7)}, rss ${rows[0].rssKiB} KiB\n`);
const intervalMs = Number.parseInt(interval, 10) * (interval.endsWith("m") ? 60_000 : 1000);
for (let cycle = 1; cycle <= cycles; cycle += 1) {
  const commit = publish(cycle);
  const pushedAt = Date.now();
  let served;
  while (Date.now() - pushedAt < intervalMs * 3) {
    await sleep(1000);
    s = await status();
    if (s.published?.commit === commit) {
      served = Date.now();
      break;
    }
  }
  const search = await client.callTool({
    name: "search",
    arguments: { question: `soak cycle ${cycle}` },
  });
  const found = JSON.stringify(search.structuredContent).includes("metrics/revenue.md");
  const row = {
    cycle,
    commit,
    pickupMs: served === undefined ? null : served - pushedAt,
    rssKiB: rssKiB(),
    admitted: s.admitted,
    documents: s.engine?.documents,
    found,
    degradations: s.degradations?.count,
    refusals: s.refusals?.count,
  };
  rows.push(row);
  process.stdout.write(
    `cycle ${cycle}: ${row.pickupMs === null ? "NOT picked up" : `picked up in ${row.pickupMs} ms`}, rss ${row.rssKiB} KiB, found ${found}\n`,
  );
}
await client.close();
const rss = rows.map((r) => r.rssKiB);
const summary = {
  stamp,
  cycles,
  interval,
  pid,
  totalMs: Date.now() - started,
  rss: { first: rss[0], last: rss.at(-1), min: Math.min(...rss), max: Math.max(...rss) },
  pickupMs: rows.slice(1).map((r) => r.pickupMs),
  missed: rows.slice(1).filter((r) => r.pickupMs === null).length,
  notFound: rows.slice(1).filter((r) => !r.found).length,
  stderrWarnings: stderr
    .split("\n")
    .filter((l) => l.includes('"level":"warn"') || l.includes('"level":"error"')).length,
  rows,
};
writeFileSync(join(outDir, `soak-${stamp}.json`), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ rss: summary.rss, missed: summary.missed, notFound: summary.notFound, stderrWarnings: summary.stderrWarnings, totalMs: summary.totalMs })}\n`,
);
rmSync(work, { recursive: true, force: true });
