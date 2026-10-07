import { parseFrontmatter, splitFrontmatter } from "./frontmatter.js";
import type { Degradation, ReservedFile } from "./model.js";
import { folderOf } from "./paths.js";

const KNOWN_VERSIONS = new Set(["0.1", "0.2"]);

/** index.md and log.md are reserved at any depth (specification §3.1); nothing else is. */
export function reservedKind(path: string): "index" | "log" | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "index.md") return "index";
  if (name === "log.md") return "log";
  return undefined;
}

/** Reads a reserved file. Frontmatter is tolerated and kept; when it does not parse, that is a degradation, never a refusal. */
export function parseReserved(path: string, text: string): ReservedFile {
  const kind = reservedKind(path);
  if (kind === undefined) throw new Error(`${path} is not a reserved file name`);
  const folder = folderOf(path);
  const degradations: Degradation[] = [];
  const split = splitFrontmatter(text);
  let frontmatter: Record<string, unknown> | undefined;
  let okfVersion: string | undefined;
  if (split.block !== undefined) {
    const parsed = parseFrontmatter(split.block);
    if (parsed.ok) {
      frontmatter = parsed.data;
      if (kind === "index" && folder === "" && Object.hasOwn(parsed.data, "okf_version")) {
        const raw = parsed.data.okf_version;
        okfVersion = parsed.sources.okf_version ?? (typeof raw === "string" ? raw : String(raw));
        if (!KNOWN_VERSIONS.has(okfVersion)) {
          degradations.push({
            path,
            code: "okf-version-unknown",
            field: "okf_version",
            detail: `okf_version ${okfVersion} is not a version this server knows; read as best effort`,
          });
        }
      }
    } else {
      degradations.push({
        path,
        code: "reserved-frontmatter-unparseable",
        field: "frontmatter",
        detail: parsed.error,
      });
    }
  }
  const result: ReservedFile = { kind, path, folder, body: split.body, text, degradations };
  if (frontmatter !== undefined) result.frontmatter = frontmatter;
  if (okfVersion !== undefined) result.okfVersion = okfVersion;
  return result;
}
