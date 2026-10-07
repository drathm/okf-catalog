import { describe, expect, it } from "vitest";
import { createBatchReader } from "../../src/bundle/cat-file.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const header = (sha: string, size: number, type = "blob"): Buffer =>
  Buffer.from(`${sha} ${type} ${size}\n`, "utf8");

function collect() {
  const blobs: Array<{ path: string; bytes: string }> = [];
  const reader = createBatchReader(
    [
      { sha: SHA_A, size: 5, path: "a.md" },
      { sha: SHA_B, size: 3, path: "dir/b.md" },
      { sha: SHA_A, size: 5, path: "copy.md" },
    ],
    (entry, bytes) =>
      void blobs.push({ path: entry.path, bytes: Buffer.from(bytes).toString("latin1") }),
  );
  return { reader, blobs };
}

describe("createBatchReader (cat-file --batch)", () => {
  it("writes each blob to its path in the order asked, whatever the chunk boundaries, a shared blob twice", () => {
    const { reader, blobs } = collect();
    const stream = Buffer.concat([
      header(SHA_A, 5),
      Buffer.from("he\r\nl\n"),
      header(SHA_B, 3),
      Buffer.from("xyz\n"),
      header(SHA_A, 5),
      Buffer.from("he\r\nl\n"),
    ]);
    for (let i = 0; i < stream.length; i += 4) reader.feed(stream.subarray(i, i + 4));
    reader.finish();
    expect(blobs).toEqual([
      { path: "a.md", bytes: "he\r\nl" },
      { path: "dir/b.md", bytes: "xyz" },
      { path: "copy.md", bytes: "he\r\nl" },
    ]);
  });

  it("stops on a header whose size is not the listing's, so a lying header is never buffered", () => {
    const { reader } = collect();
    expect(() => reader.feed(Buffer.concat([header(SHA_A, 9), Buffer.from("hello\n")]))).toThrow(
      /size/,
    );
  });

  it("stops on a missing object, a wrong object, a wrong type and a stream that ends early", () => {
    const missing = collect();
    expect(() => missing.reader.feed(Buffer.from(`${SHA_A} missing\n`))).toThrow(/missing/);
    const wrong = collect();
    expect(() => wrong.reader.feed(header(SHA_B, 3))).toThrow(/expected/);
    const type = collect();
    expect(() => type.reader.feed(header(SHA_A, 5, "tree"))).toThrow(/blob/);
    const short = collect();
    short.reader.feed(Buffer.concat([header(SHA_A, 5), Buffer.from("hel")]));
    expect(() => short.reader.finish()).toThrow(/ended/);
    const extra = collect();
    extra.reader.feed(
      Buffer.concat([
        header(SHA_A, 5),
        Buffer.from("hello\n"),
        header(SHA_B, 3),
        Buffer.from("xyz\n"),
        header(SHA_A, 5),
        Buffer.from("hello\n"),
      ]),
    );
    expect(() => extra.reader.feed(Buffer.from("junk"))).toThrow(/after the last blob/);
  });
});
