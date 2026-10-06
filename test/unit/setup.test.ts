import { describe, expect, it } from "vitest";

describe("test environment", () => {
  it("runs fourteen hours ahead of UTC, so local-time bugs cannot hide", () => {
    expect(new Date("2000-06-01T12:00:00Z").getTimezoneOffset()).toBe(-840);
  });
});
