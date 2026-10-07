import { describe, expect, it } from "vitest";
import { parseTimestamp } from "../../src/bundle/timestamp.js";

describe("parseTimestamp", () => {
  it("reads a date as the start of that UTC day, whatever the machine's zone", () => {
    const r = parseTimestamp("2000-01-31");
    expect(r).toEqual({ kind: "date", at: new Date(Date.UTC(2000, 0, 31)) });
  });

  it("reads a datetime with Z as that instant", () => {
    const r = parseTimestamp("2000-06-01T18:00:00Z");
    expect(r).toEqual({ kind: "datetime", offset: true, at: new Date(Date.UTC(2000, 5, 1, 18)) });
  });

  it("applies a numeric offset", () => {
    const r = parseTimestamp("2000-06-01T18:00:00+02:00");
    expect(r).toEqual({ kind: "datetime", offset: true, at: new Date(Date.UTC(2000, 5, 1, 16)) });
  });

  it("reads a datetime without an offset as UTC and says the offset was missing", () => {
    const r = parseTimestamp("2000-06-01T18:00:00");
    expect(r).toEqual({ kind: "datetime", offset: false, at: new Date(Date.UTC(2000, 5, 1, 18)) });
  });

  it("accepts fractional seconds and a datetime without seconds", () => {
    expect(parseTimestamp("2000-06-01T18:00:00.250Z")).toMatchObject({ kind: "datetime" });
    expect(parseTimestamp("2000-06-01T18:00Z")).toMatchObject({ kind: "datetime" });
  });

  it("rejects impossible calendar dates instead of rolling them over", () => {
    expect(parseTimestamp("2026-02-30")).toMatchObject({ kind: "invalid" });
    expect(parseTimestamp("2000-13-01")).toMatchObject({ kind: "invalid" });
    expect(parseTimestamp("2000-06-01T24:00:00Z")).toMatchObject({ kind: "invalid" });
  });

  it("rejects the forms Date.parse would accept but the grammar does not", () => {
    for (const raw of [
      "2000-6-1",
      "June 1 2000",
      "2000-06-01 18:00:00Z",
      "2000-06-01t18:00:00z",
      "soon",
      "",
    ]) {
      expect(parseTimestamp(raw), raw).toMatchObject({ kind: "invalid" });
    }
  });
});

describe("parseTimestamp: review round 1 additions", () => {
  it("accepts a leap day in 2000 and rejects one in 1900", () => {
    expect(parseTimestamp("2000-02-29")).toMatchObject({ kind: "date" });
    expect(parseTimestamp("1900-02-29")).toMatchObject({ kind: "invalid" });
  });

  it("crosses UTC midnight for a negative offset and keeps fractional seconds", () => {
    expect(parseTimestamp("2000-06-01T00:30:00-01:00")).toMatchObject({
      at: new Date(Date.UTC(2000, 5, 1, 1, 30)),
    });
    expect(parseTimestamp("2000-06-01T23:30:00+02:00")).toMatchObject({
      at: new Date(Date.UTC(2000, 5, 1, 21, 30)),
    });
    expect(parseTimestamp("2000-06-01T18:00:00.250Z")).toMatchObject({
      at: new Date(Date.UTC(2000, 5, 1, 18, 0, 0, 250)),
    });
    expect(parseTimestamp("2000-06-01T23:59:60Z")).toMatchObject({
      at: new Date(Date.UTC(2000, 5, 1, 23, 59, 59, 999)),
    });
  });
});
