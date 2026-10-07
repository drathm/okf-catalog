/** What one `cat-file --batch` answer must be: the blob asked for, at the size the listing gave. */
export interface ExpectedBlob {
  sha: string;
  size: number;
  path: string;
}

export interface BatchReader {
  /** Feeds the next chunk of stdout; throws on the first byte that is not what the listing promised. */
  feed(chunk: Buffer): void;
  /** Called at the end of stdout; throws when a blob is still owed. */
  finish(): void;
}

const HEADER = /^([0-9a-f]{40,64}) (\S+)(?: (\d+))?$/;

/**
 * Reads `cat-file --batch` output for a known list of blobs, in order: `<sha> blob <size>\n`, the raw bytes, a
 * newline. Each header is checked against the listing (the object, its type and its size) before a byte of
 * content is kept, so a header that lies is never buffered (bite 5 review m1). Blob bytes reach `onBlob` whole.
 */
export function createBatchReader(
  expected: readonly ExpectedBlob[],
  onBlob: (entry: ExpectedBlob, bytes: Buffer) => void,
): BatchReader {
  const queue = [...expected];
  let pending: Buffer = Buffer.alloc(0);
  let current: { entry: ExpectedBlob; got: Buffer[]; gotLength: number } | undefined;
  let awaitingNewline = false;
  let done = false;

  function feed(chunk: Buffer): void {
    if (done) {
      if (chunk.length > 0) throw new Error("cat-file printed more after the last blob");
      return;
    }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      if (awaitingNewline) {
        if (pending.length === 0) return;
        if (pending[0] !== 0x0a)
          throw new Error("cat-file printed an unexpected byte after a blob");
        pending = pending.subarray(1);
        awaitingNewline = false;
        if (queue.length === 0) {
          done = true;
          if (pending.length > 0) throw new Error("cat-file printed more after the last blob");
          return;
        }
      }
      if (current === undefined) {
        const newline = pending.indexOf(0x0a);
        if (newline === -1) return;
        const header = pending.subarray(0, newline).toString("utf8");
        pending = pending.subarray(newline + 1);
        const match = HEADER.exec(header);
        const next = queue[0];
        if (match === null || next === undefined)
          throw new Error("cat-file printed a header this reader cannot parse");
        if (match[2] === "missing") throw new Error(`the object for ${next.path} is missing`);
        if (match[1] !== next.sha)
          throw new Error(`cat-file answered ${match[1]} where ${next.sha} was expected`);
        if (match[2] !== "blob")
          throw new Error(`the object for ${next.path} is a ${match[2]}, not a blob`);
        if (Number(match[3] ?? -1) !== next.size)
          throw new Error(
            `cat-file reports size ${match[3] ?? "?"} for ${next.path}, the listing said ${next.size}`,
          );
        queue.shift();
        current = { entry: next, got: [], gotLength: 0 };
      }
      const take = Math.min(current.entry.size - current.gotLength, pending.length);
      if (take > 0) {
        current.got.push(pending.subarray(0, take));
        current.gotLength += take;
        pending = pending.subarray(take);
      }
      if (current.gotLength < current.entry.size) return;
      onBlob(current.entry, Buffer.concat(current.got));
      current = undefined;
      awaitingNewline = true;
    }
  }

  function finish(): void {
    if (queue.length > 0 || current !== undefined || awaitingNewline)
      throw new Error("cat-file ended before every blob arrived");
  }

  return { feed, finish };
}
