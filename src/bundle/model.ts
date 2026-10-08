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
  /**
   * Set when the entry wrote a `usage_window` that is not a `from`/`to` mapping: it is reported, and the entry takes
   * no window, not the page's, since its producer framed its count otherwise (D62). Never part of a result.
   */
  usageWindowIgnored?: true;
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
  /** The link's text, whitespace collapsed: the words a mention is made with (issue 5). */
  text: string;
  /** The prose of the nearest heading at or before the link; absent before any heading. Never the page title. */
  heading?: string;
}

/**
 * A footnote reference in the body (issue 5): the identifier GFM records, lower-cased; the prose of the smallest
 * paragraph, heading, list item, block quote or table cell holding it, cut at 500 characters, which is the
 * sentence a joined source supports and never the footnote's definition; and the nearest heading.
 */
export interface FootnoteReference {
  id: string;
  block: string;
  heading?: string;
}

/** The path-valued fields of §6.2, named by the role an edge from each plays (issue 5). */
export type PathRole = "resource" | "source" | "computation" | "executor" | "attester";

/**
 * What a path field names (issue 5's classifier, D70): a URL leaf; an admitted page (`concept`); a reserved file,
 * an attachment or a folder; two of those at once (`ambiguous`); a page file the bundle holds but did not admit
 * (`unserved`); a scope descriptor, which only a source's resource can be; or nothing (`unresolved`).
 */
export type PathTargetKind =
  | "url"
  | "concept"
  | "reserved"
  | "attachment"
  | "folder"
  | "ambiguous"
  | "unserved"
  | "scope"
  | "unresolved";

export interface PathTarget {
  kind: PathTargetKind;
  /** The bundle path named, for every kind but `url`, `scope`, `ambiguous` and `unresolved`. */
  target?: string;
  /** Both paths an ambiguous value names, in name order: the path as written, then the concept id's file. */
  candidates?: string[];
  /** Read from the bundle root after the page's folder held nothing by that name (D70). */
  fromRoot?: boolean;
}

/** One path field of a page, classified once at load after admission (D69): never fetched, opened or run. */
export interface PathEdge extends PathTarget {
  role: PathRole;
  /** `resource`, `sources[i].resource` (i counts the page's sources as `get_page` returns them), `computation`, `executor.resource` or `attester.resource`. */
  field: string;
  /** The index of the source in the page's sources, for a source edge. */
  source?: number;
  /** The value as written. */
  raw: string;
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
  | "legacy-timestamp"
  | "legacy-citations"
  | "path-field-root-relative"
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
  | "bundle-path-missing"
  /**
   * The bundle could not be loaded at the network's first load while another bundle could (its source threw: a
   * folder that is gone, a repository that cannot be fetched; or its index could not be written): it is published
   * as refused, so the network serves the others (D75). Never a loader's rule; the detail is the failure's sentence.
   */
  | "load-failed";

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
  /** The OKF 0.1 top-level `timestamp`, kept only when `generated` is absent (§13.1, D79); never a generator. */
  timestamp?: Timestamp;
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
  footnoteReferences: FootnoteReference[];
  /** The page's path fields, classified by the loader once the bundle's admission is known (D69); empty before. */
  pathEdges: PathEdge[];
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
  /** The manifest's `published_at`, as written, when the manifest was read (D74); never the git fetch time. */
  publishedAt?: string;
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
  /**
   * The words of the admission list, other than the three known statuses, that no page carries, as listed and
   * trimmed, each once: a typo such as `depreciated` admits nothing, and says so (D77, amended after the build review).
   */
  unmatchedAdmits: string[];
}
