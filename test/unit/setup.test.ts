import { describe, expect, it } from "vitest";

describe("test environment", () => {
  it("runs at one of the two offsets the projects set, so local-time bugs cannot hide", () => {
    expect([-840, 660]).toContain(new Date("2000-06-01T12:00:00Z").getTimezoneOffset());
  });
});
