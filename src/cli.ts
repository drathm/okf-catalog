#!/usr/bin/env node
import { createRequire } from "node:module";

const USAGE = `usage: okf-catalog <command> [options]

commands:
  check <bundle folder>   apply the intake contract to a folder and print the report
  pack                    write the bundle a server will serve, with its manifest
  serve                   serve the company's bundle to an MCP client over stdio

options:
  --version   print the version
  --help      print this text
`;

// The floor is the Active LTS line at the time of the release (the maintainer's ruling, 2026-10-07): Node 24.
// (Below that, better-sqlite3 13's binary needs Node-API 10, which 22.12 and 22.13 lack; they die by a signal at
// the first database open, bisected on the first CI run.)
const MIN_NODE: [number, number] = [24, 0];

function nodeIsSupported(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

function version(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
}

/** The host is checked before any command module, and so any native binding, is loaded. */
async function main(argv: string[]): Promise<number> {
  if (!nodeIsSupported()) {
    process.stderr.write(
      `okf-catalog needs Node ${MIN_NODE[0]}.${MIN_NODE[1]} or later; this is ${process.versions.node}\n`,
    );
    return 2;
  }
  if (process.platform === "win32") {
    process.stderr.write(
      "Windows is not a version 0 host: the cache folder's ownership and mode checks assume POSIX\n",
    );
    return 2;
  }
  const [command, ...rest] = argv;
  const io = {
    stdout: (text: string) => void process.stdout.write(text),
    stderr: (text: string) => void process.stderr.write(text),
    env: process.env,
  };
  switch (command) {
    case "--version":
      process.stdout.write(`${version()}\n`);
      return 0;
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    case "check": {
      const { CHECK_USAGE, runCheck } = await import("./commands/check.js");
      if (rest.includes("--help")) {
        process.stdout.write(CHECK_USAGE);
        return 0;
      }
      return runCheck(rest, io);
    }
    case "pack": {
      const { PACK_USAGE, runPack } = await import("./commands/pack.js");
      if (rest.includes("--help")) {
        process.stdout.write(PACK_USAGE);
        return 0;
      }
      return runPack(rest, io);
    }
    case "serve": {
      const { SERVE_USAGE, runServe } = await import("./commands/serve.js");
      if (rest.includes("--help")) {
        process.stdout.write(SERVE_USAGE);
        return 0;
      }
      return runServe(rest);
    }
    default:
      process.stderr.write(
        `${command === undefined ? "a command is required" : `unknown command or option: ${command}`}\n${USAGE}`,
      );
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
