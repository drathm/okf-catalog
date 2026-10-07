import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("the CLI entry point (shape)", () => {
  it("checks the host before it imports anything that loads a native binding", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^import .* from "\.\/commands\//m);
    expect(source).toMatch(/await import\("\.\/commands\/serve\.js"\)/);
    expect(source).toMatch(/await import\("\.\/commands\/check\.js"\)/);
    expect(source.indexOf("nodeIsSupported")).toBeLessThan(
      source.indexOf('await import("./commands/'),
    );
  });
});
