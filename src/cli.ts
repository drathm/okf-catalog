#!/usr/bin/env node
import { createRequire } from "node:module";
import { CHECK_USAGE, runCheck } from "./commands/check.js";

const USAGE = `usage: okf-catalog <command> [options]

commands:
  check <bundle folder>   apply the intake contract to a folder and print the report

options:
  --version   print the version
  --help      print this text
`;

function version(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
}

function main(argv: string[]): number {
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
    default:
      process.stderr.write(
        `${command === undefined ? "a command is required" : `unknown command or option: ${command}`}\n${USAGE}`,
      );
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
