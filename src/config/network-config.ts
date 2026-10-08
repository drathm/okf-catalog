import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";
import { type Caps, DEFAULT_CAPS, type SpecText } from "../bundle/model.js";
import { isSafeRelativePath } from "../bundle/paths.js";
import { safe } from "../catalog/text.js";
import {
  catalogCacheDir,
  folderInside,
  foldersOverlap,
  networkDir,
  realFolder,
} from "../fs/cache-dir.js";

/** Where a bundle comes from: a folder on this machine, or a published branch fetched into the cache (D47, D50). */
export type BundleSource =
  | { kind: "local"; path: string; configured: string }
  | { kind: "git"; repository: string; branch: string; bundlePath: string };

/** One bundle as the server uses it: its id, its source, and its own admission, caps, types and spec text (D76). */
export interface BundleConfig {
  id: string;
  source: BundleSource;
  /** `admit`: the statuses served, any word but `draft`, trimmed; compared without regard to case (D77). */
  serve: { admit: string[]; dev: boolean; pullIntervalMs: number };
  /** `none` for a bundle in development mode, and for it alone (D76). */
  integrity: "require-manifest" | "none";
  caps: Caps;
  types?: string[];
  specText: SpecText;
}

/** Configuration as the server uses it: paths resolved, defaults inherited, each bundle's `dev` mapped onto its drafts and integrity. */
export interface NetworkConfig {
  /** The network's name: its cache folder's, its lock's and its log's. A `company:` file's company. */
  network: string;
  /** The file's form: `network:` and `bundles:`, or `company:` and one `source:`, the alias kept until 0.5.0 (D-G). */
  form: "network" | "company";
  /** In the file's order; a `company:` file's one bundle has the company's name as its id. */
  bundles: BundleConfig[];
  /** How many hits a search returns when the caller names no limit; network-wide (D76). */
  limitDefault: number;
}

export type ConfigResult = { ok: true; config: NetworkConfig } | { ok: false; problems: string[] };

/** A network name, a company name and a bundle id: one lower-case path segment. */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NAME_RULE =
  "must be one lower-case path segment (letters, digits and hyphens, starting with a letter or digit, at most 63 characters)";
/**
 * The folder names qmd's scanner skips below a collection's root (section 4, finding 2): refused as bundle ids,
 * though one collection per bundle makes them harmless, so the one-collection fallback stays open (D73, D76).
 */
const SKIPPED = new Set(["vendor", "dist", "build"]);
const SKIPPED_RULE = "must not be vendor, dist or build, the folder names the search engine skips";
/** The scp-like repository form: a user, a host, a colon and a path that is not an option. */
const SCP_LIKE = /^[A-Za-z0-9._][A-Za-z0-9._-]*@[A-Za-z0-9.-]+:[^-\s/][^\s]*$/;
/** A branch name as one plain ref segment or a few: letters, digits, `.`, `_`, `-` and `/`, nothing a refspec or an option could misread. */
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

/** What a reader of the configuration may relax, and what it may check beyond the file. */
export interface ParseOptions {
  /** Accept `file://` repositories (a test-only setting, paired with the `file` transport protocol). */
  allowFileRepositories?: boolean;
  /**
   * The cache root the server will use: when given, a local bundle that lies inside the okf-catalog cache folder (any
   * network's part of it), or holds this network's folder, is refused, real paths compared (D76). `serve` gives it;
   * `pack`, which writes no cache, does not.
   */
  cacheRoot?: string;
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
  if (url.search.length > 0 || url.hash.length > 0)
    return "must not carry a query or a fragment (a token in a URL would reach the log)";
  if (url.protocol === "https:" && url.username.length > 0)
    return "must not carry a user name over https; use a credential helper";
  if (url.username.startsWith("-")) return "must not carry a user name that looks like an option";
  return undefined;
}

/** Why a branch name is refused (D50), or undefined when it is accepted. */
export function branchProblem(value: string): string | undefined {
  if (!BRANCH.test(value) || value.includes("..") || value.includes("//") || value.includes("@{"))
    return "must be a plain branch name of letters, digits, '.', '_', '-' and '/'";
  if (value.endsWith("/") || value.endsWith(".") || value.includes("/."))
    return "must not end in '/' or '.', and no segment may start with '.'";
  if (value === "HEAD" || value.split("/").some((segment) => segment.endsWith(".lock")))
    return "must not be HEAD, and no segment may end in '.lock'";
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

const SourceRaw = z.strictObject({
  local: z.string().min(1).optional(),
  repository: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  bundle_path: z.string().min(1).optional(),
});
const CapsRaw = z
  .strictObject({
    file_bytes: z.number().int().min(1).max(CAP_CEILINGS.file_bytes).optional(),
    files: z.number().int().min(1).max(CAP_CEILINGS.files).optional(),
    tree_bytes: z.number().int().min(1).max(CAP_CEILINGS.tree_bytes).optional(),
  })
  .optional();
const TypesRaw = z.array(z.string().min(1)).optional();
const SpecTextRaw = z.enum(["2026-08-15", "2026-08-21"]).optional();
const Admit = z.array(z.string()).optional();
const Interval = z.string().optional();
const LimitDefault = z.number().int().min(1).max(25).optional();

/** The one-bundle form, version 0's file: a company and its source, kept as an alias until 0.5.0 (D-G). */
const CompanyRaw = z.strictObject({
  company: z.string(),
  source: SourceRaw,
  serve: z
    .strictObject({
      admit: Admit,
      dev: z.boolean().optional(),
      pull_interval: Interval,
      limit_default: LimitDefault,
    })
    .optional(),
  caps: CapsRaw,
  types: TypesRaw,
  spec_text: SpecTextRaw,
});

/** One bundle of a `network:` file: its id and source, and what it sets for itself (D76). */
const BundleRaw = z.strictObject({
  id: z.string(),
  source: SourceRaw,
  serve: z
    .strictObject({ admit: Admit, dev: z.boolean().optional(), pull_interval: Interval })
    .optional(),
  caps: CapsRaw,
  types: TypesRaw,
  spec_text: SpecTextRaw,
});

/** The network form: the top-level keys are the defaults every bundle inherits; `limit_default` is the network's. */
const NetworkRaw = z.strictObject({
  network: z.string(),
  serve: z
    .strictObject({
      admit: Admit,
      // Accepted by the schema so that its refusal can say where development mode belongs.
      dev: z.boolean().optional(),
      pull_interval: Interval,
      limit_default: LimitDefault,
    })
    .optional(),
  caps: CapsRaw,
  types: TypesRaw,
  spec_text: SpecTextRaw,
  bundles: z.array(BundleRaw).min(1),
});

type RawSource = z.infer<typeof SourceRaw>;
type RawCaps = z.infer<typeof CapsRaw>;

/** A key path as a person writes it: `bundles[1].source.local`. */
function pathText(path: readonly PropertyKey[]): string {
  let text = "";
  for (const segment of path) {
    if (typeof segment === "number") text += `[${segment}]`;
    else text += text === "" ? String(segment) : `.${String(segment)}`;
  }
  return text;
}

function issueText(issue: z.core.$ZodIssue): string {
  const path = pathText(issue.path);
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

/** The admission list where it is written: any word but draft, trimmed, never blank, never empty (D77). */
function admitProblems(admit: readonly string[], key: string): string[] {
  const problems: string[] = [];
  if (admit.length === 0) problems.push(`${key}: at least one status is required`);
  if (admit.some((status) => status.toLowerCase() === "draft"))
    problems.push(`${key}: draft is admitted only through serve.dev`);
  if (admit.some((status) => status.length === 0))
    problems.push(`${key}: a status cannot be blank`);
  return problems;
}

/** A pull interval where it is written, in milliseconds, or the problem with it. */
function intervalOf(text: string, key: string): { ms: number } | { problem: string } {
  const ms = durationMs(text);
  if (ms === undefined)
    return { problem: `${key}: write a number and a unit, such as 30s, 10m or 2h` };
  if (ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS)
    return { problem: `${key}: must be between 30s and 24h` };
  return { ms };
}

/** What a bundle inherits when it does not set it itself: the network's top-level keys (D76). */
interface Inherited {
  admit?: string[];
  pullIntervalMs?: number;
  caps?: RawCaps;
  types?: string[];
  specText?: SpecText;
}

/** One bundle as written, whichever form wrote it. */
interface RawBundle {
  source: RawSource;
  serve?:
    | {
        admit?: string[] | undefined;
        dev?: boolean | undefined;
        pull_interval?: string | undefined;
      }
    | undefined;
  caps?: RawCaps | undefined;
  types?: string[] | undefined;
  spec_text?: SpecText | undefined;
}

/**
 * One bundle resolved against what it inherits: its own keys win, the network's come next, then the built-in
 * defaults; caps key by key. `key` names a key where the bundle is written (`source.local`, or
 * `bundles[1].source.local`), so every problem is a sentence naming it.
 */
function resolveBundle(
  id: string,
  raw: RawBundle,
  inherited: Inherited,
  key: (name: string) => string,
  where: { configDir: string; home: string; options: ParseOptions },
  problems: string[],
): BundleConfig | undefined {
  const before = problems.length;
  const hasLocal = raw.source.local !== undefined;
  const hasGit = raw.source.repository !== undefined;
  if (hasLocal && hasGit)
    problems.push(`${key("source")}: exactly one of local or repository, not both`);
  if (!hasLocal && !hasGit) problems.push(`${key("source")}: local or repository is required`);
  if (hasLocal && (raw.source.branch !== undefined || raw.source.bundle_path !== undefined)) {
    problems.push(`${key("source")}: branch and bundle_path belong to a repository source`);
  }
  if (hasGit) {
    const repository = repositoryProblem(raw.source.repository ?? "", where.options);
    if (repository !== undefined) problems.push(`${key("source.repository")}: ${repository}`);
    const branch = branchProblem(raw.source.branch ?? "published");
    if (branch !== undefined) problems.push(`${key("source.branch")}: ${branch}`);
    const bundle = bundlePathProblem(raw.source.bundle_path ?? ".");
    if (bundle !== undefined) problems.push(`${key("source.bundle_path")}: ${bundle}`);
  }
  // Any status word but draft (D77): a company may serve a word of its own, such as `archived`, by listing it.
  const own = raw.serve?.admit?.map((status) => status.trim());
  if (own !== undefined) problems.push(...admitProblems(own, key("serve.admit")));
  const admit = own ?? inherited.admit ?? ["stable", "deprecated"];
  const dev = raw.serve?.dev ?? false;
  if (dev && !hasLocal) problems.push(`${key("serve.dev")}: allowed only with source.local`);
  let pullIntervalMs = inherited.pullIntervalMs ?? 600_000;
  if (raw.serve?.pull_interval !== undefined) {
    const interval = intervalOf(raw.serve.pull_interval, key("serve.pull_interval"));
    if ("problem" in interval) problems.push(interval.problem);
    else pullIntervalMs = interval.ms;
  }
  if (problems.length > before) return undefined;
  const caps: Caps = {
    fileBytes: raw.caps?.file_bytes ?? inherited.caps?.file_bytes ?? DEFAULT_CAPS.fileBytes,
    files: raw.caps?.files ?? inherited.caps?.files ?? DEFAULT_CAPS.files,
    treeBytes: raw.caps?.tree_bytes ?? inherited.caps?.tree_bytes ?? DEFAULT_CAPS.treeBytes,
  };
  const bundle: BundleConfig = {
    id,
    source:
      raw.source.local !== undefined
        ? {
            kind: "local",
            path: resolvePath(raw.source.local, where.configDir, where.home),
            configured: raw.source.local,
          }
        : {
            kind: "git",
            repository: raw.source.repository ?? "",
            branch: raw.source.branch ?? "published",
            bundlePath: raw.source.bundle_path ?? ".",
          },
    serve: { admit, dev, pullIntervalMs },
    // Development mode turns integrity off for its own bundle and no other (D76).
    integrity: dev ? "none" : "require-manifest",
    caps,
    specText: raw.spec_text ?? inherited.specText ?? "2026-08-15",
  };
  const types = raw.types ?? inherited.types;
  if (types !== undefined && types.length > 0) bundle.types = types;
  return bundle;
}

/** Why an id or a company name is refused, or undefined: one path segment, and not a name qmd skips. */
function nameProblem(value: string, key: string): string | undefined {
  if (!NAME.test(value)) return `${key}: ${NAME_RULE}`;
  if (SKIPPED.has(value)) return `${key}: ${SKIPPED_RULE}`;
  return undefined;
}

/**
 * The local folders the network may not use (D76), each compared by its real path, so a link to a folder or its name
 * in another case on a file system that ignores case is that folder (C-A-A6): a folder inside the okf-catalog cache
 * folder, whichever network's part of it, or holding this network's; a folder inside another bundle's, or holding it.
 */
function folderProblems(
  network: string,
  bundles: ReadonlyArray<{ bundle: BundleConfig; key: (name: string) => string }>,
  options: ParseOptions,
): string[] {
  const problems: string[] = [];
  const cache =
    options.cacheRoot === undefined
      ? undefined
      : {
          all: realFolder(catalogCacheDir(options.cacheRoot)),
          own: realFolder(networkDir(options.cacheRoot, network)),
        };
  const real = bundles.map(({ bundle }) =>
    bundle.source.kind === "local" ? realFolder(bundle.source.path) : undefined,
  );
  bundles.forEach(({ key }, index) => {
    const path = real[index];
    if (path === undefined) return;
    if (cache !== undefined && (folderInside(path, cache.all) || folderInside(cache.own, path))) {
      problems.push(
        `${key("source.local")}: lies inside the okf-catalog cache folder (every network's) or holds this network's; set XDG_CACHE_HOME to a folder outside the bundle`,
      );
    }
    const earlier = bundles.findIndex((_, other) => {
      const there = real[other];
      return other < index && there !== undefined && foldersOverlap(there, path);
    });
    if (earlier !== -1) {
      problems.push(
        `${key("source.local")}: lies inside the folder of bundle ${JSON.stringify(bundles[earlier]?.bundle.id)}, or holds it; two bundles never share a file`,
      );
    }
  });
  return problems;
}

/** The `company:` form: a network of the company's name with one bundle of that id (D-G). */
function parseCompanyForm(
  document: object,
  where: { configDir: string; home: string; options: ParseOptions },
): ConfigResult {
  const parsed = CompanyRaw.safeParse(document);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map(issueText) };
  const raw = parsed.data;
  const problems: string[] = [];
  const name = nameProblem(raw.company, "company");
  if (name !== undefined) problems.push(name);
  const bundle = resolveBundle(raw.company, raw, {}, (k) => k, where, problems);
  if (bundle === undefined || problems.length > 0) return { ok: false, problems };
  problems.push(...folderProblems(raw.company, [{ bundle, key: (k) => k }], where.options));
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      network: raw.company,
      form: "company",
      bundles: [bundle],
      limitDefault: raw.serve?.limit_default ?? 8,
    },
  };
}

/** The `network:` form: every bundle with what it inherits from the top-level keys (D76). */
function parseNetworkForm(
  document: object,
  where: { configDir: string; home: string; options: ParseOptions },
): ConfigResult {
  const parsed = NetworkRaw.safeParse(document);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map(issueText) };
  const raw = parsed.data;
  const problems: string[] = [];
  if (!NAME.test(raw.network)) problems.push(`network: ${NAME_RULE}`);
  if (raw.serve?.dev !== undefined) {
    problems.push(
      "serve.dev: set it on the local bundle it is for (bundles[n].serve.dev); a network: file has no development mode of its own",
    );
  }
  const inherited: Inherited = {};
  if (raw.serve?.admit !== undefined) {
    inherited.admit = raw.serve.admit.map((status) => status.trim());
    problems.push(...admitProblems(inherited.admit, "serve.admit"));
  }
  if (raw.serve?.pull_interval !== undefined) {
    const interval = intervalOf(raw.serve.pull_interval, "serve.pull_interval");
    if ("problem" in interval) problems.push(interval.problem);
    else inherited.pullIntervalMs = interval.ms;
  }
  if (raw.caps !== undefined) inherited.caps = raw.caps;
  if (raw.types !== undefined) inherited.types = raw.types;
  if (raw.spec_text !== undefined) inherited.specText = raw.spec_text;
  const resolved: Array<{ bundle: BundleConfig; key: (name: string) => string }> = [];
  const firstWithId = new Map<string, number>();
  raw.bundles.forEach((entry, index) => {
    const key = (name: string): string => `bundles[${index}].${name}`;
    const name = nameProblem(entry.id, key("id"));
    if (name !== undefined) problems.push(name);
    const first = firstWithId.get(entry.id);
    if (first !== undefined) {
      problems.push(
        `${key("id")}: ${JSON.stringify(entry.id)} is the id of bundles[${first}] too; each bundle needs its own`,
      );
    } else firstWithId.set(entry.id, index);
    const bundle = resolveBundle(entry.id, entry, inherited, key, where, problems);
    if (bundle !== undefined) resolved.push({ bundle, key });
  });
  if (problems.length > 0) return { ok: false, problems };
  problems.push(...folderProblems(raw.network, resolved, where.options));
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      network: raw.network,
      form: "network",
      bundles: resolved.map((r) => r.bundle),
      limitDefault: raw.serve?.limit_default ?? 8,
    },
  };
}

/**
 * Parses a network's YAML configuration, in either form: `network:` with `bundles:`, or `company:` with one
 * `source:`, which is a network of that name with one bundle of that id (the alias kept until 0.5.0, D-G). A file
 * that names both is refused. Every problem is a sentence naming the key; nothing is guessed.
 */
export function parseNetworkConfig(
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
  const hasCompany = Object.hasOwn(document, "company");
  const hasNetwork = Object.hasOwn(document, "network");
  if (hasCompany && hasNetwork) {
    return {
      ok: false,
      problems: [
        "company and network: a file names one network with network: and bundles:, or one bundle with company: and source:, never both",
      ],
    };
  }
  if (!hasCompany && !hasNetwork) {
    return {
      ok: false,
      problems: [
        "network: required (network: and bundles:), or company: with one source: for a one-bundle network",
      ],
    };
  }
  const where = { configDir, home, options: parseOptions };
  return hasNetwork ? parseNetworkForm(document, where) : parseCompanyForm(document, where);
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
          "OKF_CATALOG_CONFIG is empty or still holds a placeholder; set it to the configuration file's path, put okf-catalog.yaml in the project folder, or pass --config",
      };
    }
    return { path: expand(value), rule: "env" };
  }
  return { path: join(cwd, "okf-catalog.yaml"), rule: "cwd" };
}

/** Reads and parses a configuration file; relative paths inside it resolve against the file's folder. */
/** A configuration is a short file; anything over this is refused unread. */
export const CONFIG_SIZE_CAP = 1024 * 1024;

export function readNetworkConfig(
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
  return parseNetworkConfig(text, dirname(path), home, parseOptions);
}
