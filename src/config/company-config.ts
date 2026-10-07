import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";
import { type Caps, DEFAULT_CAPS, type SpecText, type Status } from "../bundle/model.js";
import { isSafeRelativePath } from "../bundle/paths.js";
import { safe } from "../catalog/text.js";

/** Configuration as the server uses it: paths resolved, defaults applied, `dev` mapped onto drafts and integrity. */
export interface CompanyConfig {
  company: string;
  source:
    | { kind: "local"; path: string; configured: string }
    | { kind: "git"; repository: string; branch: string; bundlePath: string };
  serve: { admit: Status[]; dev: boolean; pullIntervalMs: number; limitDefault: number };
  integrity: "require-manifest" | "none";
  caps: Caps;
  types?: string[];
  specText: SpecText;
}

export type ConfigResult = { ok: true; config: CompanyConfig } | { ok: false; problems: string[] };

const COMPANY = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The scp-like repository form: a user, a host, a colon and a path that is not an option. */
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^-\s/][^\s]*$/;
/** A branch name as one plain ref segment or a few: letters, digits, `.`, `_`, `-` and `/`, nothing a refspec or an option could misread. */
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

/** What a reader of the configuration may relax; only the suite does. */
export interface ParseOptions {
  /** Accept `file://` repositories (a test-only setting, paired with the `file` transport protocol). */
  allowFileRepositories?: boolean;
}

/** Why a repository string is not one the server will fetch (D50), or undefined when it is. */
export function repositoryProblem(value: string, options: ParseOptions = {}): string | undefined {
  if (SCP_LIKE.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an https:// or ssh:// URL, or user@host:path";
  }
  if (url.protocol === "file:" && options.allowFileRepositories === true) return undefined;
  if (url.protocol !== "https:" && url.protocol !== "ssh:")
    return "must be an https:// or ssh:// URL, or user@host:path (a local path or another scheme is not fetched)";
  if (url.hostname.length === 0) return "must name a host";
  if (url.password.length > 0) return "must not carry a password; use a credential helper";
  if (url.protocol === "https:" && url.username.length > 0)
    return "must not carry a user name over https; use a credential helper";
  return undefined;
}

/** Why a branch name is refused (D50), or undefined when it is accepted. */
export function branchProblem(value: string): string | undefined {
  if (!BRANCH.test(value) || value.includes("..") || value.includes("//") || value.includes("@{"))
    return "must be a plain branch name of letters, digits, '.', '_', '-' and '/'";
  if (value.endsWith("/") || value.endsWith(".lock") || value.endsWith(".") || value.includes("/."))
    return "must not end in '/', '.' or '.lock', and no segment may start with '.'";
  return undefined;
}

/** Why a bundle path is refused (D50), or undefined: `.` or a safe relative path with no dot-leading segment. */
export function bundlePathProblem(value: string): string | undefined {
  if (value === ".") return undefined;
  if (!isSafeRelativePath(value) || value.endsWith("/"))
    return "must be '.' or a relative path with no empty, '.', '..' or backslash segments";
  if (value.split("/").some((segment) => segment.startsWith(".")))
    return "must not name a hidden folder (a segment starting with '.')";
  return undefined;
}
const DURATION = /^(\d+)(s|m|h)$/;
const MIN_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CAP_CEILINGS = {
  file_bytes: 64 * 1024 * 1024,
  files: 200_000,
  tree_bytes: 8 * 1024 * 1024 * 1024,
};

const Raw = z.strictObject({
  company: z.string(),
  source: z.strictObject({
    local: z.string().min(1).optional(),
    repository: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    bundle_path: z.string().min(1).optional(),
  }),
  serve: z
    .strictObject({
      admit: z.array(z.string()).optional(),
      dev: z.boolean().optional(),
      pull_interval: z.string().optional(),
      limit_default: z.number().int().min(1).max(25).optional(),
    })
    .optional(),
  caps: z
    .strictObject({
      file_bytes: z.number().int().min(1).max(CAP_CEILINGS.file_bytes).optional(),
      files: z.number().int().min(1).max(CAP_CEILINGS.files).optional(),
      tree_bytes: z.number().int().min(1).max(CAP_CEILINGS.tree_bytes).optional(),
    })
    .optional(),
  types: z.array(z.string().min(1)).optional(),
  spec_text: z.enum(["2026-08-15", "2026-08-21"]).optional(),
});

function issueText(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join(".");
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((k) => `${path === "" ? k : `${path}.${k}`}: unknown key`).join("; ");
  }
  return `${path === "" ? "document" : path}: ${issue.message}`;
}

/** `~/x` against the home folder, an absolute path as is, anything else against the configuration file's folder. */
function resolvePath(value: string, configDir: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  if (isAbsolute(value)) return value;
  return resolve(configDir, value);
}

function durationMs(text: string): number | undefined {
  const m = DURATION.exec(text);
  if (m === null) return undefined;
  const n = Number(m[1]);
  const unit = m[2] === "s" ? 1000 : m[2] === "m" ? 60_000 : 3_600_000;
  return n * unit;
}

/** Parses one company's YAML configuration. Every problem is a sentence naming the key; nothing is guessed. */
export function parseCompanyConfig(
  text: string,
  configDir: string,
  home: string,
  parseOptions: ParseOptions = {},
): ConfigResult {
  let document: unknown;
  try {
    document = parseYaml(text, { version: "1.2" });
  } catch (error) {
    // The parser's message carries a code frame of the file on later lines: the first line names the problem.
    const first = (error as Error).message.split("\n")[0] ?? "";
    return { ok: false, problems: [`the configuration is not valid YAML: ${safe(first)}`] };
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, problems: ["the configuration must be a mapping of keys to values"] };
  }
  const parsed = Raw.safeParse(document);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map(issueText) };
  const raw = parsed.data;
  const problems: string[] = [];
  if (!COMPANY.test(raw.company)) {
    problems.push(
      "company: must be one lower-case path segment (letters, digits and hyphens, starting with a letter or digit, at most 63 characters)",
    );
  }
  const hasLocal = raw.source.local !== undefined;
  const hasGit = raw.source.repository !== undefined;
  if (hasLocal && hasGit) problems.push("source: exactly one of local or repository, not both");
  if (!hasLocal && !hasGit) problems.push("source: local or repository is required");
  if (hasLocal && (raw.source.branch !== undefined || raw.source.bundle_path !== undefined)) {
    problems.push("source: branch and bundle_path belong to a repository source");
  }
  if (hasGit) {
    const repository = repositoryProblem(raw.source.repository ?? "", parseOptions);
    if (repository !== undefined) problems.push(`source.repository: ${repository}`);
    const branch = branchProblem(raw.source.branch ?? "published");
    if (branch !== undefined) problems.push(`source.branch: ${branch}`);
    const bundle = bundlePathProblem(raw.source.bundle_path ?? ".");
    if (bundle !== undefined) problems.push(`source.bundle_path: ${bundle}`);
  }
  const admit = raw.serve?.admit ?? ["stable", "deprecated"];
  if (admit.length === 0) problems.push("serve.admit: at least one status is required");
  for (const status of admit) {
    if (status === "draft") problems.push("serve.admit: draft is admitted only through serve.dev");
    else if (status !== "stable" && status !== "deprecated")
      problems.push(`serve.admit: ${JSON.stringify(status)} is not a status`);
  }
  const dev = raw.serve?.dev ?? false;
  if (dev && !hasLocal) problems.push("serve.dev: allowed only with source.local");
  let pullIntervalMs = 600_000;
  if (raw.serve?.pull_interval !== undefined) {
    const ms = durationMs(raw.serve.pull_interval);
    if (ms === undefined) {
      problems.push("serve.pull_interval: write a number and a unit, such as 30s, 10m or 2h");
    } else if (ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) {
      problems.push("serve.pull_interval: must be between 30s and 24h");
    } else pullIntervalMs = ms;
  }
  if (problems.length > 0) return { ok: false, problems };
  const caps: Caps = {
    fileBytes: raw.caps?.file_bytes ?? DEFAULT_CAPS.fileBytes,
    files: raw.caps?.files ?? DEFAULT_CAPS.files,
    treeBytes: raw.caps?.tree_bytes ?? DEFAULT_CAPS.treeBytes,
  };
  const config: CompanyConfig = {
    company: raw.company,
    source:
      raw.source.local !== undefined
        ? {
            kind: "local",
            path: resolvePath(raw.source.local, configDir, home),
            configured: raw.source.local,
          }
        : {
            kind: "git",
            repository: raw.source.repository ?? "",
            branch: raw.source.branch ?? "published",
            bundlePath: raw.source.bundle_path ?? ".",
          },
    serve: {
      admit: admit as Status[],
      dev,
      pullIntervalMs,
      limitDefault: raw.serve?.limit_default ?? 8,
    },
    integrity: dev ? "none" : "require-manifest",
    caps,
    specText: raw.spec_text ?? "2026-08-15",
  };
  if (raw.types !== undefined && raw.types.length > 0) config.types = raw.types;
  return { ok: true, config };
}

export type Discovery = { path: string; rule: "flag" | "env" | "cwd" } | { error: string };

/**
 * Where the configuration is: the flag, then `OKF_CATALOG_CONFIG`, then `okf-catalog.yaml` in the working
 * folder. A variable that is set but empty, or that still holds a `${...}` placeholder, is an error and never
 * falls through, so a checked-out repository can never choose the bundle by accident.
 */
export function discoverConfigPath(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
  home: string,
): Discovery {
  // A leading `~/` is expanded as it is inside the file; nothing else is interpreted.
  const expand = (value: string): string =>
    value.startsWith("~/") ? join(home, value.slice(2)) : resolve(cwd, value);
  if (flag !== undefined) return { path: expand(flag), rule: "flag" };
  if (Object.hasOwn(env, "OKF_CATALOG_CONFIG")) {
    const value = (env.OKF_CATALOG_CONFIG ?? "").trim();
    if (value.length === 0 || value.includes("${")) {
      return {
        error:
          "OKF_CATALOG_CONFIG is empty or still holds a placeholder; run /plugin configure okf-catalog to set the configuration path, or pass --config",
      };
    }
    return { path: expand(value), rule: "env" };
  }
  return { path: join(cwd, "okf-catalog.yaml"), rule: "cwd" };
}

/** Reads and parses a configuration file; relative paths inside it resolve against the file's folder. */
/** A configuration is a short file; anything over this is refused unread. */
export const CONFIG_SIZE_CAP = 1024 * 1024;

export function readCompanyConfig(
  path: string,
  home: string,
  parseOptions: ParseOptions = {},
): ConfigResult {
  let text: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return { ok: false, problems: [`the configuration path ${path} is not a regular file`] };
    }
    if (stat.size > CONFIG_SIZE_CAP) {
      return {
        ok: false,
        problems: [
          `the configuration file ${path} is too large (${stat.size} bytes, over ${CONFIG_SIZE_CAP})`,
        ],
      };
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const why =
      code === "ENOENT"
        ? "does not exist"
        : code === "EISDIR"
          ? "is a folder, not a file"
          : `cannot be read (${code ?? "error"})`;
    return { ok: false, problems: [`the configuration file ${path} ${why}`] };
  }
  return parseCompanyConfig(text, dirname(path), home, parseOptions);
}
