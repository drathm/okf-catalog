/**
 * Timestamps by explicit grammar, never by Date.parse: a date is `YYYY-MM-DD`, a datetime is an RFC 3339
 * profile with an optional `Z` or `±hh:mm` offset. Values are built with Date.UTC and checked against the
 * calendar, so an impossible date is rejected rather than rolled over and the machine's zone never matters.
 */
export type ParsedTimestamp =
  | { kind: "date"; at: Date }
  | { kind: "datetime"; at: Date; offset: boolean }
  | { kind: "invalid"; reason: string };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/;

function utcDay(year: number, month: number, day: number): number | undefined {
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day)
    return undefined;
  return ms;
}

export function parseTimestamp(raw: string): ParsedTimestamp {
  const date = DATE.exec(raw);
  if (date) {
    const ms = utcDay(Number(date[1]), Number(date[2]), Number(date[3]));
    return ms === undefined
      ? { kind: "invalid", reason: "not a calendar date" }
      : { kind: "date", at: new Date(ms) };
  }
  const dt = DATETIME.exec(raw);
  if (!dt) return { kind: "invalid", reason: "not a date or an RFC 3339 datetime" };
  const day = utcDay(Number(dt[1]), Number(dt[2]), Number(dt[3]));
  if (day === undefined) return { kind: "invalid", reason: "not a calendar date" };
  const hour = Number(dt[4]);
  const minute = Number(dt[5]);
  const second = dt[6] === undefined ? 0 : Number(dt[6]);
  if (hour > 23 || minute > 59 || second > 59)
    return { kind: "invalid", reason: "time of day out of range" };
  const millis = dt[7] === undefined ? 0 : Number(`${dt[7]}000`.slice(0, 3));
  let offsetMinutes = 0;
  const offset = dt[8];
  if (offset !== undefined && offset !== "Z") {
    const sign = offset.startsWith("-") ? -1 : 1;
    const oh = Number(offset.slice(1, 3));
    const om = Number(offset.slice(4, 6));
    if (oh > 23 || om > 59) return { kind: "invalid", reason: "offset out of range" };
    offsetMinutes = sign * (oh * 60 + om);
  }
  const at = new Date(
    day + ((hour * 60 + minute) * 60 + second) * 1000 + millis - offsetMinutes * 60_000,
  );
  return { kind: "datetime", at, offset: offset !== undefined };
}
