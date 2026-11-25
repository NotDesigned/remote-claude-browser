// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * patches/@rrweb__replay@2.1.1.patch trims the live Replayer's event list so a long session does
 * not keep every event. The trim must keep the first two, Meta and FullSnapshot: rrweb reads the
 * replay's start and its document from them.
 */
const dist = dirname(createRequire(import.meta.url).resolve("@rrweb/replay"));
const TRIM = /^\s*if \(events\.length > 4000\) events\.splice\(.*\);$/m;

describe("patched rrweb replay event trim", () => {
  for (const file of ["replay.js", "replay.cjs"]) {
    it(`keeps Meta and FullSnapshot in ${file}`, () => {
      const statement = readFileSync(join(dist, file), "utf8").match(TRIM)?.[0];
      expect(statement).toBeDefined();
      const trim = new Function("events", statement!) as (events: string[]) => void;
      const events = ["meta", "full", ...Array.from({ length: 3_999 }, (_, i) => `delta-${i}`)];
      trim(events);
      expect(events.slice(0, 2)).toEqual(["meta", "full"]);
      expect(events).toHaveLength(2_000);
      expect(events.at(-1)).toBe("delta-3998");
      expect(events[2]).toBe("delta-2001");
    });
  }
});
