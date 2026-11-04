/**
 * Claude paints some image thumbnails on a canvas and keeps the same image in a transparent <img>
 * beside it. Canvas pixels are not mirrored, so the replay shows that <img> instead of a blank box.
 * insertRule accepts @supports on any browser, so one without :has() only skips hiding the canvas.
 */
export const REPLAY_THUMBNAIL_RULES = [
  "canvas[data-cds-tile-picture] ~ img { opacity: 1 !important; }",
  "@supports selector(:has(a)) { canvas[data-cds-tile-picture]:has(~ img[src]) { visibility: hidden !important; } }",
];
