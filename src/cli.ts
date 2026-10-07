#!/usr/bin/env node
import { createRequire } from "node:module";
import { CHECK_USAGE, runCheck } from "./commands/check.js";
import { runServe, SERVE_USAGE } from "./commands/serve.js";

const USAGE = `usage: okf-catalog <command> [options]

commands:
  check <bundle folder>   apply the intake contract to a folder and print the report
  serve                   serve the company's bundle to an MCP client over stdio

options:
  --version   print the version
  --help      print this text
`;

function version(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
}

const MIN_NODE: [number, number] = [22, 12];

function nodeIsSupported(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

async function main(argv: string[]): Promise<number> {
  if (!nodeIsSupported()) {
    process.stderr.write(
      `okf-catalog needs Node ${MIN_NODE[0]}.${MIN_NODE[1]} or later; this is ${process.versions.node}\n`,
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
    case "check":
      if (rest.includes("--help")) {
        process.stdout.write(CHECK_USAGE);
        return 0;
      }
      return runCheck(rest, io);
    case "serve":
      if (rest.includes("--help")) {
        process.stdout.write(SERVE_USAGE);
        return 0;
      }
      return runServe(rest);
    default:
      process.stderr.write(
        `${command === undefined ? "a command is required" : `unknown command or option: ${command}`}\n${USAGE}`,
      );
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
