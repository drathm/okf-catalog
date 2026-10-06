#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const USAGE = `usage: okf-catalog <command> [options]

commands:
  (none yet)

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
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: { version: { type: "boolean" }, help: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (parsed.values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(USAGE);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
