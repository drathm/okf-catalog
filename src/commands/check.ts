import { parseArgs } from "node:util";
import { type LoadResult, loadBundle } from "../bundle/load.js";
import {
  type BundleFile,
  DEFAULT_CAPS,
  type LoadOptions,
  type Report,
  type SpecText,
} from "../bundle/model.js";
import { byCodeUnit } from "../bundle/paths.js";
import { encodePath } from "../engine/qmd-render.js";
import { walkBundle } from "../fs/walk.js";
import { renderReport } from "../report/report.js";

export const CHECK_USAGE = `usage: okf-catalog check <bundle folder> [options]

Applies the intake contract to a folder and prints the report.

options:
  --integrity <require-manifest|none>   default require-manifest; a source checkout needs none
  --dev                                 admit drafts and label them
  --admit <stable,deprecated>           statuses to serve, any word but draft, which only --dev admits
                                        (default stable,deprecated)
  --types <a,b>                         the company's declared types; others are reported
  --spec-text <2026-08-15|2026-08-21>   which OKF 0.2 text's date form is expected (default 2026-08-15)
  --json                                print the report as JSON

exit codes: 0 the bundle can be served; 1 something was refused; 2 usage or environment error
`;

export interface CommandIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** The clock: a fixed instant from OKF_CATALOG_NOW for deterministic runs, else now. The instant must carry its offset, or the host's time zone would decide it. */
export function clockFrom(env: NodeJS.ProcessEnv): Date {
  const fixed = env.OKF_CATALOG_NOW;
  if (fixed === undefined || fixed.length === 0) return new Date();
  if (!CLOCK.test(fixed)) {
    throw new Error(
      `OKF_CATALOG_NOW must be a datetime with an offset, such as 2026-10-06T12:00:00Z; got ${JSON.stringify(fixed)}`,
    );
  }
  const at = new Date(fixed);
  if (Number.isNaN(at.getTime()))
    throw new Error(`OKF_CATALOG_NOW is not a valid datetime: ${fixed}`);
  return at;
}

/**
 * Loads a bundle the way the server will see it: the core's report, plus the folders the search engine renames,
 * which only the engine adapter's codec knows. The command and the golden-report test both come through here.
 */
export function loadForCheck(
  company: string,
  files: BundleFile[],
  options: LoadOptions,
  now: Date,
): LoadResult {
  const result = loadBundle(company, files, options, now);
  const renamed = new Set<string>();
  for (const page of result.catalog.pages.values()) {
    if (page.folder !== "" && encodePath(page.folder) !== page.folder) renamed.add(page.folder);
  }
  result.report.encodedFolders = [...renamed].sort(byCodeUnit);
  return result;
}

/** A report as JSON: a format marker, ISO dates, nothing else. */
export function reportToJson(report: Report): string {
  return `${JSON.stringify({ okf_catalog_report: 1, ...report, loadedAt: report.loadedAt.toISOString() }, null, 2)}\n`;
}

export function runCheck(argv: string[], io: CommandIo): number {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        integrity: { type: "string", default: "require-manifest" },
        dev: { type: "boolean", default: false },
        admit: { type: "string", default: "stable,deprecated" },
        types: { type: "string" },
        "spec-text": { type: "string", default: "2026-08-15" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    io.stderr(`${(error as Error).message}\n${CHECK_USAGE}`);
    return 2;
  }
  const folder = parsed.positionals[0];
  const integrity = parsed.values.integrity;
  const specText = parsed.values["spec-text"];
  // The statuses served: any word but draft, each trimmed and none blank, the rule of serve.admit and pack --admit
  // (D77); case is ignored when pages are admitted.
  const admit = String(parsed.values.admit)
    .split(",")
    .map((s) => s.trim());
  if (admit.every((s) => s.length === 0)) {
    io.stderr(`--admit needs at least one status\n${CHECK_USAGE}`);
    return 2;
  }
  if (admit.some((s) => s.length === 0)) {
    io.stderr(`--admit lists a blank status\n${CHECK_USAGE}`);
    return 2;
  }
  if (admit.some((s) => s.toLowerCase() === "draft")) {
    io.stderr(`--admit takes statuses other than draft; --dev admits drafts\n${CHECK_USAGE}`);
    return 2;
  }
  const types =
    parsed.values.types === undefined
      ? undefined
      : String(parsed.values.types)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
  if (types !== undefined && types.length === 0) {
    io.stderr(`--types needs at least one type name\n${CHECK_USAGE}`);
    return 2;
  }
  if (folder === undefined || parsed.positionals.length !== 1) {
    io.stderr(`check takes exactly one bundle folder\n${CHECK_USAGE}`);
    return 2;
  }
  if (integrity !== "require-manifest" && integrity !== "none") {
    io.stderr(`--integrity must be require-manifest or none\n${CHECK_USAGE}`);
    return 2;
  }
  if (specText !== "2026-08-15" && specText !== "2026-08-21") {
    io.stderr(`--spec-text must be 2026-08-15 or 2026-08-21\n${CHECK_USAGE}`);
    return 2;
  }
  let now: Date;
  try {
    now = clockFrom(io.env);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 2;
  }
  let walked: ReturnType<typeof walkBundle>;
  try {
    walked = walkBundle(folder, DEFAULT_CAPS);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 2;
  }
  const options: LoadOptions = {
    admit,
    dev: parsed.values.dev === true,
    integrity,
    specText: specText as SpecText,
    caps: DEFAULT_CAPS,
    walkRefusals: walked.refusals,
    hiddenPaths: walked.hidden,
    hiddenFolders: walked.hiddenFolders,
  };
  if (types !== undefined) options.types = types;
  if (walked.fatal !== undefined) options.walkFatal = walked.fatal;
  let report: Report;
  try {
    report = loadForCheck("check", walked.files, options, now).report;
  } catch (error) {
    // Content problems never throw; this is the last resort for a defect, told apart from a refusal by its code.
    io.stderr(`check failed on a defect, not on the bundle: ${(error as Error).message}\n`);
    return 2;
  }
  io.stdout(parsed.values.json === true ? reportToJson(report) : renderReport(report));
  return report.fatal !== undefined || report.refusals.length > 0 ? 1 : 0;
}
