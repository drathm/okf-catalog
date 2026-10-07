import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  parseManifest,
  sha256Hex,
  verifyManifest,
} from "../../src/bundle/manifest.js";
import { FIXTURES, readFixture } from "../helpers/fixtures.js";

const committed = (bundle: string): Uint8Array =>
  readFileSync(join(FIXTURES, bundle, "manifest.json"));
const META = {
  commit: "0000000000000000000000000000000000000000",
  publishedAt: "2026-10-06T00:00:00Z",
};

describe("manifest", () => {
  it("parses the committed fixture manifests", () => {
    for (const bundle of ["spec-example", "behaviours", "refused"]) {
      const r = parseManifest(committed(bundle));
      expect(r.ok, bundle).toBe(true);
    }
  });

  it("builds exactly the committed manifest from the fixture's files", () => {
    const files = readFixture("spec-example").filter((f) => f.path !== "manifest.json");
    const built = buildManifest(files, META);
    const parsed = parseManifest(committed("spec-example"));
    expect(parsed.ok && parsed.manifest).toEqual(built);
    expect(Object.keys(built.files)).toEqual([...Object.keys(built.files)].sort());
  });

  it("verifies a faithful tree with no problems", () => {
    const files = readFixture("behaviours");
    const parsed = parseManifest(committed("behaviours"));
    expect(parsed.ok && verifyManifest(parsed.manifest, files)).toEqual([]);
  });

  it("reports a tampered byte as a hash mismatch and a truncated file as a size mismatch", () => {
    const files = readFixture("behaviours");
    const parsed = parseManifest(committed("behaviours"));
    if (!parsed.ok) throw new Error(parsed.error);
    const tampered = files.map((f) => {
      if (f.path !== "terms/alpha.md") return f;
      const bytes = Uint8Array.from(f.bytes);
      bytes[bytes.length - 2] = 0x21;
      return { path: f.path, bytes };
    });
    expect(verifyManifest(parsed.manifest, tampered)).toEqual([
      { path: "terms/alpha.md", problem: "hash-mismatch" },
    ]);
    const truncated = files.map((f) =>
      f.path === "terms/beta.md" ? { path: f.path, bytes: f.bytes.slice(0, 10) } : f,
    );
    expect(verifyManifest(parsed.manifest, truncated)).toEqual([
      { path: "terms/beta.md", problem: "size-mismatch" },
    ]);
  });

  it("reports a file the manifest does not list, and a listed file that is missing", () => {
    const files = readFixture("behaviours");
    const parsed = parseManifest(committed("behaviours"));
    if (!parsed.ok) throw new Error(parsed.error);
    const extra = [...files, { path: "terms/new.md", bytes: new Uint8Array([1]) }];
    expect(verifyManifest(parsed.manifest, extra)).toEqual([
      { path: "terms/new.md", problem: "not-in-manifest" },
    ]);
    const missing = files.filter((f) => f.path !== "terms/zeta.md");
    expect(verifyManifest(parsed.manifest, missing)).toEqual([
      { path: "terms/zeta.md", problem: "missing-on-disk" },
    ]);
  });

  it("rejects unsafe paths, bad hashes, unknown keys and other format versions", () => {
    const base = { okf_catalog: 1, commit: META.commit, published_at: META.publishedAt, files: {} };
    const bad = (patch: Record<string, unknown>) =>
      parseManifest(new TextEncoder().encode(JSON.stringify({ ...base, ...patch })));
    expect(bad({ files: { "../escape.md": { sha256: "a".repeat(64), bytes: 1 } } }).ok).toBe(false);
    expect(bad({ files: { "/abs.md": { sha256: "a".repeat(64), bytes: 1 } } }).ok).toBe(false);
    expect(bad({ files: { "x.md": { sha256: "zz", bytes: 1 } } }).ok).toBe(false);
    expect(bad({ files: { "x.md": { sha256: "a".repeat(64), bytes: 1.5 } } }).ok).toBe(false);
    expect(bad({ extra: true }).ok).toBe(false);
    expect(bad({ okf_catalog: 2 }).ok).toBe(false);
    expect(bad({ commit: "abc" }).ok).toBe(false);
    expect(bad({ published_at: "2026-10-06T00:00:00+00:00" }).ok).toBe(true);
    expect(parseManifest(new TextEncoder().encode("{not json")).ok).toBe(false);
  });

  it("hashes bytes with sha256 in lower-case hex", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("manifest: prototype keys (review round 1)", () => {
  it("rejects a files key named __proto__ instead of letting the schema drop it silently", () => {
    const text = `{"okf_catalog":1,"commit":"${META.commit}","published_at":"${META.publishedAt}","files":{"__proto__":{"sha256":"${"a".repeat(64)}","bytes":1}}}`;
    const r = parseManifest(new TextEncoder().encode(text));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/__proto__/);
  });

  it("refuses to build a manifest for a file whose path has a __proto__ segment", () => {
    expect(() =>
      buildManifest([{ path: "__proto__/x.md", bytes: new Uint8Array(1) }], META),
    ).toThrow(/__proto__/);
  });
});
