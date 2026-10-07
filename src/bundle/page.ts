import { decodeUtf8, parseFrontmatter, splitFrontmatter } from "./frontmatter.js";
import { type LinkIndex, resolveLink } from "./links.js";
import { sha256Hex } from "./manifest.js";
import { readBody } from "./markdown.js";
import type {
  BundleFile,
  Degradation,
  DegradationCode,
  Link,
  Page,
  PagePath,
  Refusal,
  RefusalRule,
  Source,
  SpecText,
  StaleAfter,
  Status,
  Timestamp,
  Trust,
  Verification,
} from "./model.js";
import { folderOf } from "./paths.js";
import { parseTimestamp } from "./timestamp.js";

export interface PageContext {
  linkIndex: LinkIndex;
  specText: SpecText;
}

export type ParsePageResult = { ok: true; page: Page } | { ok: false; refusal: Refusal };

const STATUSES: ReadonlySet<string> = new Set<Status>(["draft", "stable", "deprecated"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a value is, for a sentence: "a list", "a mapping", "a number", "empty". */
function kindOf(value: unknown): string {
  if (value === null || value === undefined) return "empty";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a mapping";
  return `a ${typeof value}`;
}

function stemOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

/** The verification with the latest instant; among entries without one, the last listed. */
export function latestVerification(verified: readonly Verification[]): Verification | undefined {
  let best: Verification | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const v of verified) {
    const at = v.at?.at?.getTime();
    if (at === undefined) {
      if (best === undefined) best = v;
      continue;
    }
    if (best === undefined || best.at?.at === undefined || at >= bestAt) {
      best = v;
      bestAt = at;
    }
  }
  if (best !== undefined && best.at?.at === undefined) {
    for (const v of verified) if (v.at?.at === undefined) best = v;
  }
  return best;
}

/** Turns one file into a page, deriving every field with its source and a degradation wherever a fallback was used. */
export function parsePage(file: BundleFile, ctx: PageContext): ParsePageResult {
  const path = file.path;
  const degradations: Degradation[] = [];
  const degrade = (code: DegradationCode, field: string, detail: string): void => {
    degradations.push({ path, code, field, detail });
  };
  const refuse = (rule: RefusalRule, detail: string): ParsePageResult => ({
    ok: false,
    refusal: { path, rule, detail },
  });

  const decoded = decodeUtf8(file.bytes);
  if (!decoded.ok) return refuse("not-utf8", "the file is not valid UTF-8");
  const split = splitFrontmatter(decoded.text);
  if (split.block === undefined) {
    return refuse(
      "no-frontmatter",
      split.unclosed === true
        ? "the frontmatter block opened on line 1 is never closed"
        : "no frontmatter block opens the file",
    );
  }
  const parsed = parseFrontmatter(split.block, 1);
  if (!parsed.ok) return refuse("frontmatter-unparseable", parsed.error);
  const { data, sources: scalarText } = parsed;
  for (const warning of parsed.warnings) degrade("frontmatter-warning", "frontmatter", warning);

  /** A top-level value read as text: strings as they are, numbers and booleans by their source text, reported. */
  const text = (key: string): string | undefined => {
    const value = data[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
      const asText = scalarText[key] ?? String(value);
      degrade("scalar-coerced", key, `${key} is a ${typeof value}, read as "${asText}"`);
      return asText;
    }
    return undefined;
  };

  if (!Object.hasOwn(data, "type")) return refuse("no-type", "the frontmatter has no type");
  const type = text("type")?.trim();
  if (type === undefined) return refuse("no-type", `type is ${kindOf(data.type)}, not text`);
  if (type.length === 0) return refuse("no-type", "type is empty");

  const facts = readBody(split.body);
  if (facts.unanalysed) {
    degrade(
      "body-unanalysed",
      "body",
      "the body nests deeper than the analyser allows; no title, description or links were taken from it",
    );
  }
  if (facts.truncated)
    degrade("body-truncated", "body", "only the first 256 KiB of the body were analysed");

  let title = text("title")?.trim();
  let titleSource: Page["titleSource"] = "frontmatter";
  if (Object.hasOwn(data, "title") && title === undefined) {
    degrade("field-ignored", "title", `title is ${kindOf(data.title)}, not text; ignored`);
  }
  if (title === undefined || title.length === 0) {
    if (facts.firstHeading !== undefined && facts.firstHeading.length > 0) {
      title = facts.firstHeading;
      titleSource = "heading";
      degrade(
        "title-from-heading",
        "title",
        `no title field; the first heading "${title}" is used`,
      );
    } else {
      title = stemOf(path);
      titleSource = "filename";
      degrade(
        "title-from-filename",
        "title",
        `no title field and no heading; the file name "${title}" is used`,
      );
    }
  }

  let description = text("description")?.trim();
  let descriptionSource: Page["descriptionSource"] = "frontmatter";
  if (Object.hasOwn(data, "description") && description === undefined) {
    degrade(
      "field-ignored",
      "description",
      `description is ${kindOf(data.description)}, not text; ignored`,
    );
  }
  if (description === undefined || description.length === 0) {
    if (facts.firstSentence !== undefined) {
      description = facts.firstSentence;
      descriptionSource = "body";
      degrade(
        "description-from-body",
        "description",
        "no description field; the body's first sentence is used",
      );
    } else {
      description = undefined;
      descriptionSource = "none";
      degrade(
        "description-missing",
        "description",
        "no description field and no body text to take one from",
      );
    }
  }

  const tags: string[] = [];
  const rawTags = data.tags;
  if (Array.isArray(rawTags)) {
    rawTags.forEach((tag, i) => {
      if (typeof tag === "string") tags.push(tag);
      else if (typeof tag === "number" || typeof tag === "boolean") tags.push(String(tag));
      else degrade("field-ignored", "tags", `tags[${i}] is ${kindOf(tag)}, not text; ignored`);
    });
  } else if (typeof rawTags === "string") {
    tags.push(rawTags);
    degrade("tags-not-list", "tags", "tags is a single string, read as one tag");
  } else if (rawTags !== undefined && rawTags !== null) {
    degrade("tags-not-list", "tags", `tags is ${kindOf(rawTags)}, not a list; ignored`);
  }

  const statusResult = normaliseStatus(data.status, Object.hasOwn(data, "status"), degrade);

  let staleAfter: StaleAfter | undefined;
  if (
    Object.hasOwn(data, "stale_after") &&
    data.stale_after !== null &&
    data.stale_after !== undefined
  ) {
    const raw = text("stale_after") ?? JSON.stringify(data.stale_after);
    const ts = parseTimestamp(raw);
    const expected = ctx.specText === "2026-08-15" ? "date" : "datetime";
    if (ts.kind === "date") staleAfter = { raw, form: "date", at: ts.at };
    else if (ts.kind === "datetime") {
      staleAfter = { raw, form: "datetime", at: ts.at };
      if (!ts.offset)
        degrade("stale-after-no-offset", "stale_after", `${raw} has no offset and is read as UTC`);
    } else {
      staleAfter = { raw, form: "unparseable" };
      degrade(
        "stale-after-unparseable",
        "stale_after",
        `${raw} is not a date or a datetime; the page is never overdue`,
      );
    }
    if (staleAfter.form !== "unparseable" && staleAfter.form !== expected) {
      degrade(
        "stale-after-unexpected-form",
        "stale_after",
        `the ${ctx.specText} text expects a ${expected}; ${raw} is a ${staleAfter.form}`,
      );
    }
  }

  const timestamp = (value: unknown, field: string): Timestamp => {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    const ts = parseTimestamp(raw);
    if (ts.kind === "invalid") {
      degrade("timestamp-invalid", field, `${raw} is not a date or a datetime`);
      return { raw };
    }
    return { raw, at: ts.at };
  };

  let generated: Page["generated"];
  if (Object.hasOwn(data, "generated")) {
    const g = data.generated;
    if (isRecord(g) && typeof g.by === "string" && g.by.trim().length > 0) {
      generated = { by: g.by.trim() };
      if (Object.hasOwn(g, "at")) generated.at = timestamp(g.at, "generated.at");
    } else {
      degrade(
        "generated-malformed",
        "generated",
        `generated is ${kindOf(g)} without a by actor; ignored`,
      );
    }
  }

  const verified: Verification[] = [];
  if (Object.hasOwn(data, "verified")) {
    const v = data.verified;
    const entries: unknown[] = Array.isArray(v) ? v : isRecord(v) ? [v] : [];
    if (!Array.isArray(v) && !isRecord(v)) {
      degrade(
        "verified-entry-malformed",
        "verified",
        `verified is ${kindOf(v)}, neither a list nor a mapping; ignored`,
      );
    }
    entries.forEach((entry, i) => {
      if (isRecord(entry) && typeof entry.by === "string" && entry.by.trim().length > 0) {
        const verification: Verification = { by: entry.by.trim() };
        if (Object.hasOwn(entry, "at") && entry.at !== null)
          verification.at = timestamp(entry.at, `verified[${i}].at`);
        else
          degrade(
            "verification-without-at",
            "verified",
            `verified[${i}] by ${verification.by} has no at`,
          );
        verified.push(verification);
      } else {
        degrade("verified-entry-malformed", "verified", `verified[${i}] has no by actor; ignored`);
      }
    });
  }
  const trust: Trust =
    verified.length === 0
      ? "unverified"
      : verified.some((v) => v.by.startsWith("human:"))
        ? "human-reviewed"
        : "machine-confirmed";

  const sources: Source[] = [];
  if (Object.hasOwn(data, "sources")) {
    const s = data.sources;
    if (Array.isArray(s)) {
      s.forEach((entry, i) => {
        if (isRecord(entry) && typeof entry.resource === "string" && entry.resource.length > 0) {
          const source: Source = { resource: entry.resource };
          if (typeof entry.id === "string") source.id = entry.id;
          else if (typeof entry.id === "number" || typeof entry.id === "boolean")
            source.id = String(entry.id);
          if (typeof entry.title === "string") source.title = entry.title;
          if (typeof entry.author === "string") source.author = entry.author;
          if (typeof entry.usage_count === "number") source.usageCount = entry.usage_count;
          if (typeof entry.last_modified === "string") source.lastModified = entry.last_modified;
          const w = entry.usage_window;
          if (isRecord(w) && typeof w.from === "string" && typeof w.to === "string")
            source.usageWindow = { from: w.from, to: w.to };
          sources.push(source);
        } else {
          degrade("source-malformed", "sources", `sources[${i}] has no resource; ignored`);
        }
      });
    } else {
      degrade("source-malformed", "sources", `sources is ${kindOf(s)}, not a list; ignored`);
    }
  }

  let usageWindow: Page["usageWindow"];
  const w = data.usage_window;
  if (isRecord(w) && typeof w.from === "string" && typeof w.to === "string")
    usageWindow = { from: w.from, to: w.to };

  const resource = text("resource");

  const links: Link[] = facts.links.map((l) => {
    const resolved = resolveLink(l.url, path, ctx.linkIndex);
    const link: Link = { raw: l.url, kind: resolved.kind };
    if (resolved.target !== undefined) link.target = resolved.target;
    return link;
  });

  // GFM lower-cases footnote identifiers; the join with sources[].id is case-insensitive, and each missing id is reported once.
  const sourceIds = new Set(
    sources.map((s) => s.id?.toLowerCase()).filter((id): id is string => id !== undefined),
  );
  const missing = new Set<string>();
  for (const id of facts.footnoteReferences) if (!sourceIds.has(id.toLowerCase())) missing.add(id);
  for (const id of missing)
    degrade("footnote-without-source", "sources", `footnote ${id} has no matching sources entry`);

  if (facts.htmlBlocks > 0 || facts.inlineHtml > 0 || facts.hasScriptLike) {
    const parts: string[] = [];
    if (facts.htmlBlocks > 0)
      parts.push(`${facts.htmlBlocks} HTML block${facts.htmlBlocks === 1 ? "" : "s"}`);
    if (facts.inlineHtml > 0)
      parts.push(`${facts.inlineHtml} inline HTML element${facts.inlineHtml === 1 ? "" : "s"}`);
    if (facts.hasScriptLike) parts.push("including a script-like element");
    degrade(
      "body-html",
      "body",
      `${parts.join(", ")}; indexed as text, never executed, kept out of the description`,
    );
  }

  const page: Page = {
    path,
    folder: folderOf(path),
    hash: sha256Hex(file.bytes),
    type,
    title,
    titleSource,
    descriptionSource,
    tags,
    status: statusResult.status,
    statusSource: statusResult.source,
    verified,
    trust,
    sources,
    links,
    footnoteReferences: facts.footnoteReferences,
    frontmatter: data,
    body: split.body,
    degradations,
  };
  if (description !== undefined) page.description = description;
  if (statusResult.raw !== undefined) page.statusRaw = statusResult.raw;
  if (staleAfter !== undefined) page.staleAfter = staleAfter;
  if (generated !== undefined) page.generated = generated;
  const latest = latestVerification(verified);
  if (latest !== undefined) page.latestVerification = latest;
  if (usageWindow !== undefined) page.usageWindow = usageWindow;
  if (resource !== undefined) page.resource = resource;
  return { ok: true, page };
}

function normaliseStatus(
  value: unknown,
  present: boolean,
  degrade: (code: DegradationCode, field: string, detail: string) => void,
): { status: Status; source: Page["statusSource"]; raw?: string } {
  if (!present || value === undefined || value === null)
    return { status: "stable", source: "default" };
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const normalised = raw.trim().toLowerCase();
  if (normalised.length === 0) return { status: "stable", source: "default" };
  if (STATUSES.has(normalised)) return { status: normalised as Status, source: "frontmatter", raw };
  degrade(
    "status-unknown",
    "status",
    `status "${raw}" is not draft, stable or deprecated; treated as draft`,
  );
  return { status: "draft", source: "frontmatter", raw };
}

const ARTICLE: Record<string, string> = {
  folder: "a folder",
  reserved: "an index or log file",
  attachment: "an attachment",
};

/**
 * The replacement for a deprecated page: the first body link that is not a same-page anchor decides. It is the
 * replacement when it resolves to an admitted page other than this one; otherwise there is none, and the reason is
 * recorded. Nothing is decided for a page that is not deprecated.
 */
export function decideReplacement(
  page: Page,
  admitted: ReadonlySet<PagePath>,
): { replacement?: PagePath; degradation?: Degradation } {
  if (page.status !== "deprecated") return {};
  const reason = (code: DegradationCode, detail: string) => ({
    degradation: { path: page.path, code, field: "replacement", detail },
  });
  const first = page.links.find((l) => l.kind !== "anchor");
  if (first === undefined)
    return reason(
      "replacement-missing",
      "a deprecated page should link to the page that replaced it; no link was found",
    );
  switch (first.kind) {
    case "external":
      return reason(
        "replacement-external",
        `the first link, ${first.raw}, points outside the bundle`,
      );
    case "broken":
      return reason(
        "replacement-broken",
        `the first link, ${first.raw}, points at nothing in the bundle`,
      );
    case "page": {
      const target = first.target ?? "";
      if (target === page.path)
        return reason("replacement-self", "the first link points at the page itself");
      if (!admitted.has(target))
        return reason(
          "replacement-not-served",
          `the first link points at ${target}, which is not served`,
        );
      return { replacement: target };
    }
    default:
      return reason(
        "replacement-not-a-page",
        `the first link, ${first.raw}, points at ${ARTICLE[first.kind] ?? first.kind}, not a page`,
      );
  }
}
