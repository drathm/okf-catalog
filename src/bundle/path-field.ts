import type { Degradation, Page, PathEdge, PathRole, PathTarget } from "./model.js";
import { conceptNames, folderOf } from "./paths.js";

/**
 * What the classifier may look a name up in: the bundle's file and folder names, never their bytes. `pages` holds
 * every page file the loader kept, admitted or not; `admitted` the ones it serves.
 */
export interface PathFieldIndex {
  admitted: ReadonlySet<string>;
  pages: ReadonlySet<string>;
  reserved: ReadonlySet<string>;
  attachments: ReadonlySet<string>;
  folders: ReadonlySet<string>;
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** A bundle path from a written one: segments percent-decoded, `.` and empty ones dropped; undefined above the root. */
function resolvePath(path: string, base: string): string | undefined {
  const stack = base === "" ? [] : base.split("/");
  for (const raw of path.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return undefined;
      stack.pop();
      continue;
    }
    if (/[/\\\0]/.test(segment)) return undefined;
    stack.push(segment);
  }
  return stack.join("/");
}

/** The served kind a name has: an admitted page, a reserved file, an attachment or a folder. */
function servedKind(name: string, index: PathFieldIndex): PathTarget["kind"] | undefined {
  if (index.admitted.has(name)) return "concept";
  if (index.reserved.has(name)) return "reserved";
  if (index.attachments.has(name)) return "attachment";
  if (index.folders.has(name)) return "folder";
  return undefined;
}

/**
 * The two names a resolved path means (§2): the path, and the file whose concept id it is. One served hit is that
 * kind; two are ambiguous and both are named. A page file held but not admitted counts only when nothing served
 * answers, so a held draft never makes an edge ambiguous (D70). A trailing slash names a folder only.
 */
function lookup(
  target: string | undefined,
  folderHint: boolean,
  index: PathFieldIndex,
): PathTarget | undefined {
  if (target === undefined) return undefined;
  if (folderHint) return index.folders.has(target) ? { kind: "folder", target } : undefined;
  const hits: Array<{ kind: PathTarget["kind"]; name: string }> = [];
  for (const name of conceptNames(target)) {
    const kind = servedKind(name, index);
    if (kind !== undefined) hits.push({ kind, name });
  }
  const [only] = hits;
  if (only !== undefined && hits.length === 1) return { kind: only.kind, target: only.name };
  if (hits.length > 1) return { kind: "ambiguous", candidates: hits.map((hit) => hit.name) };
  const held = conceptNames(target).find((name) => index.pages.has(name));
  return held === undefined ? undefined : { kind: "unserved", target: held };
}

/** A path's shape (issue 5): a leading `/`, `./` or `../`, a slash anywhere, or a dot in the last segment. */
function hasPathShape(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.includes("/") ||
    value.slice(value.lastIndexOf("/") + 1).includes(".")
  );
}

/**
 * Classifies one path field's value (issue 5's steps, with D70's departures), for the page at `fromPath`. A scheme
 * or a leading `//` is a URL leaf, its fragment kept. Otherwise one fragment and one query are stripped (an empty
 * remainder names nothing on any field), and the path resolves as a body link's does: from the root after a
 * leading `/`, else from the page's folder; then its two names are looked up. A bare relative path that contains a
 * slash and names nothing from the page's folder is read once from the bundle root, the form the specification's
 * own example uses (D70); a single-segment name, `./x` and `../x` never are. Only a source's resource that names
 * nothing, holds whitespace and has no path shape is a scope. Nothing is fetched, opened or run.
 */
export function classifyPathField(
  value: string,
  role: PathRole,
  fromPath: string,
  index: PathFieldIndex,
): PathTarget {
  const trimmed = value.trim();
  if (SCHEME.test(trimmed) || trimmed.startsWith("//")) return { kind: "url" };
  const stripped = trimmed.split("#")[0]?.split("?")[0] ?? "";
  if (stripped.length === 0) return { kind: "unresolved" };
  const folderHint = stripped.endsWith("/");
  const absolute = stripped.startsWith("/");
  const folder = folderOf(fromPath);
  const found = lookup(resolvePath(stripped, absolute ? "" : folder), folderHint, index);
  if (found !== undefined) return found;
  const bare = !absolute && !stripped.startsWith("./") && !stripped.startsWith("../");
  if (bare && folder !== "" && stripped.includes("/")) {
    const rooted = lookup(resolvePath(stripped, ""), folderHint, index);
    if (rooted !== undefined) return { ...rooted, fromRoot: true };
  }
  if (role === "source" && /\s/.test(trimmed) && !hasPathShape(trimmed)) return { kind: "scope" };
  return { kind: "unresolved" };
}

/** Fields named in a degradation's detail before the rest is elided. */
const NAMED_FIELDS = 5;

/**
 * A page's path fields as edges, in the order the walk reads them: `resource` when it is a non-empty string, each
 * source's `resource`, then the contract's `computation`, `executor.resource` and `attester.resource` when they are
 * strings (D69). A page whose fields were read from the bundle root carries one `path-field-root-relative`
 * degradation, however many fields it names.
 */
export function pathEdgesOf(
  page: Page,
  index: PathFieldIndex,
): { edges: PathEdge[]; degradation?: Degradation } {
  const edges: PathEdge[] = [];
  const add = (role: PathRole, field: string, raw: string, source?: number): void => {
    edges.push({
      role,
      field,
      ...(source === undefined ? {} : { source }),
      raw,
      ...classifyPathField(raw, role, page.path, index),
    });
  };
  if (page.resource !== undefined && page.resource.length > 0)
    add("resource", "resource", page.resource);
  page.sources.forEach((source, i) => {
    add("source", `sources[${i}].resource`, source.resource, i);
  });
  const contract = page.contract;
  if (contract?.computation !== undefined) add("computation", "computation", contract.computation);
  if (contract?.executor?.resource !== undefined)
    add("executor", "executor.resource", contract.executor.resource);
  if (contract?.attester?.resource !== undefined)
    add("attester", "attester.resource", contract.attester.resource);
  const rooted = edges.filter((edge) => edge.fromRoot === true).map((edge) => edge.field);
  const [first] = rooted;
  if (first === undefined) return { edges };
  const one = rooted.length === 1;
  const named = rooted.slice(0, NAMED_FIELDS).join(", ");
  return {
    edges,
    degradation: {
      path: page.path,
      code: "path-field-root-relative",
      field: first,
      detail: `${rooted.length} path field${one ? " names" : "s name"} nothing from the page's folder and ${one ? "was" : "were"} read from the bundle root, as written without a leading /: ${named}${rooted.length > NAMED_FIELDS ? ", …" : ""}`,
    },
  };
}
