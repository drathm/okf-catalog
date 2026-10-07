import type { Caps } from "../bundle/model.js";
import { type WalkResult, walkBundle } from "../fs/walk.js";

/** A bundle folder on disk, walked afresh on every load. */
export interface LocalSource {
  kind: "local";
  load(): WalkResult;
  /** The source as written in the configuration, never a resolved or cache path. */
  describe(): string;
}

export function createLocalSource(
  source: { path: string; configured: string },
  caps: Caps,
): LocalSource {
  return {
    kind: "local",
    load: () => walkBundle(source.path, caps),
    describe: () => source.configured,
  };
}
