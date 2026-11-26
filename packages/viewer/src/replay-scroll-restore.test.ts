// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * patches/@rrweb__replay@2.1.1.patch announces each element replay puts back where it was
 * scrolled ("scroll-restore"), before writing it, so the viewer can tell the native scroll event
 * that follows from the person's (pipeline/scroll.ts, watchReplayScrollRestores).
 */
const dist = dirname(createRequire(import.meta.url).resolve("@rrweb/replay"));
const ANNOUNCE = /^function announceRestoredScroll\(emitter, node2, mirror2\) \{\n[\s\S]*?\n\}$/m;

describe("patched rrweb replay scroll restore", () => {
  for (const file of ["replay.js", "replay.cjs"]) {
    const source = readFileSync(join(dist, file), "utf8");

    it(`announces only scrolled elements in ${file}`, () => {
      const declaration = source.match(ANNOUNCE)?.[0];
      expect(declaration).toBeDefined();
      const announce = new Function(`${declaration}; return announceRestoredScroll;`)() as (
        emitter: { emit(event: string, node: unknown): void },
        node: unknown,
        mirror: { getMeta(node: unknown): unknown },
      ) => void;
      const emitted: unknown[] = [];
      const emitter = { emit: (event: string, node: unknown) => emitted.push([event, node]) };
      const metas = new Map<unknown, unknown>([
        ["scrolled", { attributes: { rr_scrollTop: 800 } }],
        ["sideways", { attributes: { rr_scrollLeft: 4 } }],
        ["plain", { attributes: { id: "x" } }],
        ["text", { textContent: "x" }],
      ]);
      const mirror = { getMeta: (node: unknown) => metas.get(node) ?? null };
      for (const node of ["scrolled", "sideways", "plain", "text", "unknown"])
        announce(emitter, node, mirror);
      expect(emitted).toEqual([
        ["scroll-restore", "scrolled"],
        ["scroll-restore", "sideways"],
      ]);
    });

    it(`announces before writing, for a snapshot and for a frame's document, in ${file}`, () => {
      expect(source).toMatch(
        /rebuild\(event\.data\.node, \{\n\s*doc: this\.iframe\.contentDocument,\n\s*onVisit: \(node2\) => announceRestoredScroll\(this\.emitter, node2, this\.mirror\),/,
      );
      expect(source).toMatch(
        /announceRestoredScroll\(this\.emitter, node, mirror2\);\n\s*handleScroll\(node, mirror2\);/,
      );
      // rrweb's rebuild calls onVisit for a node before putting it back where it was scrolled.
      expect(source).toMatch(
        /visit\(mirror2, \(visitedNode\) => \{\n\s*if \(onVisit\) \{\n\s*onVisit\(visitedNode\);\n\s*\}\n\s*handleScroll\(visitedNode, mirror2\);/,
      );
    });
  }
});
