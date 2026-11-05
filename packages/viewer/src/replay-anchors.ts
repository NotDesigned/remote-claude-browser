/**
 * Claude places its slash command menu with CSS anchor positioning, on a span it wraps around the
 * typed command. That span is inside the editor, whose remote changes the replay holds back while
 * the person types into its local copy, so the menu finds no anchor and falls to the page's left
 * edge. The focused editor stands in, and the span takes over once it arrives: of two elements with
 * one anchor name, the browser uses the later one.
 */
export const REPLAY_ANCHOR_RULES = [
  ".ProseMirror:focus, .ProseMirror-focused { anchor-name: --slash-command-menu; }",
];
