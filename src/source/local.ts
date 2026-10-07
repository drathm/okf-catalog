import type { Caps } from "../bundle/model.js";
import { walkBundle } from "../fs/walk.js";
import type { Loaded, Source } from "./source.js";

/** A bundle folder on disk, walked afresh on every load. */
export interface LocalSource extends Source {
  kind: "local";
}

export function createLocalSource(
  source: { path: string; configured: string },
  caps: Caps,
): LocalSource {
  return {
    kind: "local",
    load: async (): Promise<Loaded> => {
      try {
        return { walk: walkBundle(source.path, caps) };
      } catch (error) {
        // The model is told the source as configured; the resolved path travels as detail, for the log only.
        const original = (error as Error).message;
        const described = new Error(
          original.split(source.path).join(source.configured),
        ) as Error & {
          detail?: string;
        };
        described.detail = original;
        throw described;
      }
    },
    describe: () => source.configured,
  };
}
