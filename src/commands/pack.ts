import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildManifest, MANIFEST_NAME } from "../bundle/manifest.js";
import type { BundleFile, LoadOptions, Status } from "../bundle/model.js";
import { findCollision } from "../bundle/paths.js";
import { reservedKind } from "../bundle/reserved.js";
import { readCompanyConfig } from "../config/company-config.js";
import { cacheOverlapsBundle } from "../fs/cache-dir.js";
import { walkBundle } from "../fs/walk.js";
import { renderReport } from "../report/report.js";
import { type CommandIo, clockFrom, loadForCheck } from "./check.js";

export const PACK_USAGE = `usage: okf-catalog pack --config <path> --from <bundle folder> --out <folder> [options]

Writes the bundle a server will serve: the admitted pages, the reserved files and the attachments as they are,
an index.md for every folder of pages that lacks one, and a manifest covering every file. The output folder
must be new or empty and must not lie inside the source folder (nor the reverse). Nothing is written when the
loader refuses a file; the report says why and the exit code is 1.

options:
  --config <path>     the company configuration (admission, caps, types, spec text)
  --from <folder>     the bundle folder to pack (a checkout's bundle folder, never a repository root)
  --out <folder>      where to write; new or empty
  --admit <status>    admit this status (stable, deprecated); may be repeated; default from the configuration
  --commit <sha>      the source commit to record in the manifest; the zero commit without it
  --help              print this text

exit codes: 0 packed; 1 the loader refused a file; 2 usage, configuration or output-folder problem
`;

const ZERO_COMMIT = "0".repeat(40);
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const STATUSES = new Set<Status>(["stable", "deprecated"]);

/** `YYYY-MM-DDTHH:mm:ssZ`, the form the fixtures carry, so a pack under OKF_CATALOG_NOW reproduces them. */
const publishedAt = (now: Date): string => now.toISOString().replace(/\.\d{3}Z$/, "Z");

function usage(io: CommandIo, message: string): number {
  io.stderr(`${message}\n${PACK_USAGE}`);
  return 2;
}

/** The real path of a folder that may not exist yet: its nearest existing ancestor's, plus the rest. */
function realPathOf(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  return join(realPathOf(dirname(absolute)), basename(absolute));
}

export function runPack(argv: string[], io: CommandIo): number {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        config: { type: "string" },
        from: { type: "string" },
        out: { type: "string" },
        admit: { type: "string", multiple: true },
        commit: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    return usage(io, (error as Error).message);
  }
  const {
    config: configPath,
    from,
    out,
    commit,
  } = parsed.values as {
    config?: string;
    from?: string;
    out?: string;
    commit?: string;
  };
  const admitFlags = (parsed.values.admit as string[] | undefined) ?? [];
  if (configPath === undefined || from === undefined || out === undefined)
    return usage(io, "--config, --from and --out are required");
  if (commit !== undefined && !COMMIT.test(commit))
    return usage(io, "--commit must be a full commit hash in lower-case hex");
  const admit: Status[] = [];
  for (const flag of admitFlags) {
    if (!STATUSES.has(flag as Status))
      return usage(io, `--admit must be stable or deprecated, got ${flag}`);
    admit.push(flag as Status);
  }

  const read = readCompanyConfig(resolve(configPath), homedir());
  if (!read.ok) {
    io.stderr(`the configuration is not usable: ${read.problems.join("; ")}\n`);
    return 2;
  }
  const config = read.config;

  let now: Date;
  try {
    now = clockFrom(io.env);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 2;
  }

  const fromPath = resolve(from);
  const outPath = resolve(out);
  if (!existsSync(fromPath) || !lstatSync(fromPath).isDirectory()) {
    io.stderr(`the bundle folder ${from} does not exist or is not a folder\n`);
    return 2;
  }
  const outStat = lstatSync(outPath, { throwIfNoEntry: false });
  if (outStat?.isSymbolicLink()) {
    io.stderr(`the output folder ${out} is a link; pack writes a fresh folder only\n`);
    return 2;
  }
  if (existsSync(outPath)) {
    if (!lstatSync(outPath).isDirectory() || readdirSync(outPath).length > 0) {
      io.stderr(
        `the output folder ${out} exists and is not empty; pack writes a fresh folder only\n`,
      );
      return 2;
    }
  }
  if (cacheOverlapsBundle(realPathOf(outPath), realpathSync(fromPath))) {
    io.stderr(
      `the output folder ${out} lies inside the bundle folder, or the bundle inside it; choose a folder apart\n`,
    );
    return 2;
  }

  let walked: ReturnType<typeof walkBundle>;
  try {
    walked = walkBundle(fromPath, config.caps);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 2;
  }
  const options: LoadOptions = {
    admit: admit.length > 0 ? admit : config.serve.admit,
    dev: false,
    integrity: "none",
    specText: config.specText,
    caps: config.caps,
    ...(config.types === undefined ? {} : { types: config.types }),
    walkRefusals: walked.refusals,
    hiddenPaths: walked.hidden,
    hiddenFolders: walked.hiddenFolders,
    ...(walked.fatal === undefined ? {} : { walkFatal: walked.fatal }),
  };
  const { catalog, report } = loadForCheck(config.company, walked.files, options, now);
  if (report.fatal !== undefined || report.refusals.length > 0) {
    io.stderr(renderReport(report));
    return 1;
  }

  // What travels: admitted pages, reserved files and attachments as walked, and an index where a folder of pages lacks one.
  const byPath = new Map(walked.files.map((f) => [f.path, f] as const));
  const output = new Map<string, Uint8Array>();
  const put = (path: string, bytes: Uint8Array): void => {
    output.set(path.normalize("NFC"), bytes);
  };
  for (const path of catalog.pages.keys()) {
    const file = byPath.get(path);
    if (file !== undefined) put(path, file.bytes);
  }
  for (const file of walked.files) {
    if (file.path === MANIFEST_NAME) continue;
    if (reservedKind(file.path) !== undefined || !file.path.endsWith(".md"))
      put(file.path, file.bytes);
  }
  for (const [folder, entry] of catalog.folders) {
    if (entry.indexSource === "generated" && entry.index !== undefined) {
      put(folder === "" ? "index.md" : `${folder}/index.md`, Buffer.from(entry.index.text, "utf8"));
    }
  }
  const files: BundleFile[] = [...output.entries()]
    .map(([path, bytes]) => ({ path, bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Two names a case-folding file system or the server's key would treat as one cannot be published together.
  const collision = findCollision(files.map((f) => f.path));
  if (collision !== undefined) {
    io.stderr(
      `${collision[1]} and ${collision[0]} collide under case folding or normalisation; rename one of them\n`,
    );
    return 1;
  }
  const manifest = buildManifest(files, {
    commit: commit ?? ZERO_COMMIT,
    publishedAt: publishedAt(now),
  });

  mkdirSync(outPath, { recursive: true });
  for (const file of files) {
    const target = join(outPath, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
  writeFileSync(join(outPath, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  io.stdout(renderReport(report));
  return 0;
}
