/** Core types. Pure data; nothing here touches the file system, the engine or the protocol. */

/** A bundle-relative path with POSIX separators and no leading slash. */
export type PagePath = string;

export interface BundleFile {
  path: string;
  bytes: Uint8Array;
}

/** The three statuses the specification names (§5.4). A page's own status may be any word (D61). */
export type Status = "draft" | "stable" | "deprecated";
export type Trust = "unverified" | "machine-confirmed" | "human-reviewed";
export type SpecText = "2026-08-15" | "2026-08-21";

/** A timestamp as written, with its instant when it parsed. */
export interface Timestamp {
  raw: string;
  at?: Date;
}

export interface StaleAfter {
  raw: string;
  /** date: overdue from the start of that UTC day; datetime: overdue from that instant; unparseable: never overdue. */
  form: "date" | "datetime" | "unparseable";
  at?: Date;
}

/** The `{ from, to }` range that frames a `usage_count` (§5.1), as written. */
export interface UsageWindow {
  from: string;
  to: string;
}

export interface Source {
  resource: string;
  id?: string;
  title?: string;
  author?: string;
  usageCount?: number;
  lastModified?: string;
  /** The entry's own window, which overrides the page's shared one (§5.1); never a copy of the page's. */
  usageWindow?: UsageWindow;
}

/** One typed, named hole of an attested computation (§10.2): `{ name, type, required }`. */
export interface ContractParameter {
  name: string;
  type?: string;
  required?: boolean;
}

/**
 * The contract fields of an attested computation (§10.2), typed on a page of any type (D62): what is well formed
 * is kept as written, anything else is reported and left out. Nothing runs them; the paths are not opened.
 */
export interface Contract {
  runtime?: string;
  parameters?: ContractParameter[];
  computation?: string;
  executor?: { resource?: string; receipt?: string[] };
  attester?: { resource?: string };
}

export interface Verification {
  by: string;
  at?: Timestamp;
}

export type LinkKind =
  | "page"
  | "folder"
  | "reserved"
  | "attachment"
  | "anchor"
  | "external"
  | "broken";

export interface Link {
  raw: string;
  kind: LinkKind;
  /** The bundle path the link resolved to, for page, folder, reserved and attachment links. */
  target?: string;
}

export type DegradationCode =
  | "title-from-heading"
  | "title-from-filename"
  | "description-from-body"
  | "description-missing"
  | "scalar-coerced"
  | "field-ignored"
  | "tags-not-list"
  | "status-unknown"
  | "stale-after-unparseable"
  | "stale-after-no-offset"
  | "stale-after-unexpected-form"
  | "timestamp-invalid"
  | "generated-malformed"
  | "verified-entry-malformed"
  | "source-malformed"
  | "footnote-without-source"
  | "verification-without-at"
  | "body-html"
  | "body-unanalysed"
  | "body-truncated"
  | "index-lists-unserved"
  | "replacement-missing"
  | "replacement-broken"
  | "replacement-external"
  | "replacement-not-served"
  | "replacement-self"
  | "replacement-not-a-page"
  | "frontmatter-warning"
  | "reserved-frontmatter-unparseable"
  | "reserved-unanalysed"
  | "okf-version-unknown";

export interface Degradation {
  path: string;
  code: DegradationCode;
  field: string;
  detail: string;
}

export type RefusalRule =
  | "no-frontmatter"
  | "frontmatter-unparseable"
  | "body-unreadable"
  | "no-type"
  | "not-utf8"
  | "symlink"
  | "gitlink"
  | "path-escape"
  | "special-file"
  | "unreadable"
  | "engine-config"
  | "hash-mismatch"
  | "size-mismatch"
  | "not-in-manifest"
  | "manifest-missing"
  | "manifest-invalid"
  | "oversize"
  | "too-many-files"
  | "tree-too-large"
  | "bundle-path-missing";

export interface Refusal {
  path: string;
  rule: RefusalRule;
  detail: string;
}

export interface Page {
  path: PagePath;
  folder: string;
  hash: string;
  type: string;
  title: string;
  titleSource: "frontmatter" | "heading" | "filename";
  description?: string;
  descriptionSource: "frontmatter" | "body" | "none";
  tags: string[];
  /**
   * `draft`, `stable` or `deprecated`, read without regard to case and kept as the specification spells them; any
   * other word kept as written, trimmed, with its case (D61); a list or mapping as its JSON text.
   */
  status: string;
  statusSource: "frontmatter" | "default";
  statusRaw?: string;
  staleAfter?: StaleAfter;
  generated?: { by: string; at?: Timestamp };
  verified: Verification[];
  /** The verification with the latest instant; among entries without one, the last listed. */
  latestVerification?: Verification;
  trust: Trust;
  sources: Source[];
  /** The shared window, the `usage_window` sibling of `sources` (§5.1). */
  usageWindow?: UsageWindow;
  contract?: Contract;
  resource?: string;
  replacement?: PagePath;
  links: Link[];
  footnoteReferences: string[];
  frontmatter: Record<string, unknown>;
  body: string;
  /** The body's prose for snippets, captured once at load; absent when the body could not be analysed. */
  prose?: string;
  degradations: Degradation[];
}

export interface ReservedFile {
  kind: "index" | "log";
  path: string;
  folder: string;
  frontmatter?: Record<string, unknown>;
  body: string;
  text: string;
  okfVersion?: string;
  degradations: Degradation[];
}

export interface Caps {
  fileBytes: number;
  files: number;
  treeBytes: number;
}

export const DEFAULT_CAPS: Caps = {
  fileBytes: 2 * 1024 * 1024,
  files: 20_000,
  treeBytes: 512 * 1024 * 1024,
};

export interface LoadOptions {
  /** The statuses the company admits, compared trimmed and without regard to case (D77). */
  admit: string[];
  dev: boolean;
  integrity: "require-manifest" | "none";
  specText: SpecText;
  caps: Caps;
  types?: string[];
  /** Refusals the file walker produced before the core saw the files (symbolic links, escapes, oversize). */
  walkRefusals?: Refusal[];
  /** Dot-leading paths the walker found and never read; counted, present for the manifest, refused when they are the engine's. */
  hiddenPaths?: string[];
  /** The hidden paths that are folders: a manifest entry beneath one is present even though no file arrived. */
  hiddenFolders?: string[];
  /** The walker's own bundle-level refusal, when the caps stopped it. */
  walkFatal?: Refusal;
}

export interface Report {
  loadedAt: Date;
  commit?: string;
  /** A bundle-level refusal; when set, nothing should be served. */
  fatal?: Refusal;
  /** Whether the manifest was verified against the files, or integrity was not required. */
  integrity: "checked" | "skipped";
  admitted: number;
  excludedByStatus: number;
  attachments: number;
  hidden: number;
  refusals: Refusal[];
  degradations: Degradation[];
  unknownTypes: string[];
  unknownStatuses: Array<{ path: string; value: string }>;
  brokenLinks: Array<{ from: PagePath; raw: string }>;
  linksToUnserved: Array<{ from: PagePath; raw: string; target: string }>;
  missingOnDisk: string[];
  foldersWithoutIndex: string[];
  encodedFolders: string[];
}
