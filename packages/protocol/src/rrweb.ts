/**
 * Single source for rrweb types.
 *
 * Nothing else in the workspace may import `@rrweb/types` directly — everyone re-imports
 * from `@mirror/protocol` so the exact-version pin (2.1.1, see scripts/check-rrweb-versions.mjs)
 * has one source. `@rrweb/record`, `@rrweb/replay` and both canvas-webrtc plugins MUST resolve
 * to the same version; skew produces a *silent blank replay*.
 */
export type { eventWithTime } from "@rrweb/types";
export { EventType, IncrementalSource } from "@rrweb/types";

/**
 * rrweb's default class names are also what a website uses for its own session recording: Claude
 * marks image previews with `rr-block`. Unique names keep such pages from being dropped from the
 * mirror, where a blocked element is a solid `currentColor` box.
 */
export const MIRROR_RECORD_CLASSES = {
  blockClass: "mirror-no-capture",
  ignoreClass: "mirror-no-input",
  maskTextClass: "mirror-mask-text",
} as const;
