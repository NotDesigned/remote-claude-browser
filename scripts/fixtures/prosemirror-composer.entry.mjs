/**
 * A chat composer built on the real ProseMirror, for the Compose end-to-end check: Enter sends and
 * clears the editor in place (as claude.ai's composer does), "--" becomes an em dash and
 * **text** becomes bold as typed (input rules), and an empty editor shows a placeholder.
 *
 * prosemirror-composer.js beside it is this file bundled, so that the check needs no network:
 *
 *   npm install esbuild@0.28 prosemirror-commands@1.7.2 prosemirror-inputrules@1.7.0 \
 *     prosemirror-keymap@1.2.3 prosemirror-model@1.25.13 prosemirror-schema-basic@1.2.5 \
 *     prosemirror-state@1.4.4 prosemirror-view@1.44.0
 *   npx esbuild prosemirror-composer.entry.mjs --bundle --minify --format=iife \
 *     --global-name=PMComposer --legal-comments=none --outfile=prosemirror-composer.js
 *
 * ProseMirror is MIT licensed (Marijn Haverbeke and others).
 */
import { EditorState, Plugin } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { Schema } from "prosemirror-model";
import { schema as basic } from "prosemirror-schema-basic";
import { keymap } from "prosemirror-keymap";
import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  liftEmptyBlock,
  splitBlock,
} from "prosemirror-commands";
import { inputRules, InputRule } from "prosemirror-inputrules";

const schema = new Schema({ nodes: basic.spec.nodes, marks: basic.spec.marks });

const bold = new InputRule(/\*\*([^*]+)\*\*$/, (state, match, start, end) =>
  state.tr
    .replaceWith(start, end, schema.text(match[1], [schema.marks.strong.create()]))
    .removeStoredMark(schema.marks.strong),
);

// Like tiptap's Placeholder: an is-empty class and data-placeholder on the empty first paragraph.
const placeholder = new Plugin({
  props: {
    decorations(state) {
      const doc = state.doc;
      if (doc.childCount === 1 && doc.firstChild.isTextblock && doc.firstChild.content.size === 0)
        return DecorationSet.create(doc, [
          Decoration.node(0, doc.firstChild.nodeSize, {
            class: "is-empty is-editor-empty",
            "data-placeholder": "Reply...",
          }),
        ]);
      return null;
    },
  },
});

export function mount(place, { onSend }) {
  const view = new EditorView(place, {
    state: EditorState.create({
      schema,
      plugins: [
        inputRules({ rules: [new InputRule(/--$/, "—"), bold] }),
        keymap({
          Enter: (state, _dispatch, editor) => {
            const text = state.doc.textBetween(0, state.doc.content.size, "\n");
            if (text.trim() === "") return true;
            onSend(text);
            editor.dispatch(editor.state.tr.delete(0, editor.state.doc.content.size));
            return true;
          },
          "Shift-Enter": chainCommands(createParagraphNear, liftEmptyBlock, splitBlock),
        }),
        keymap(baseKeymap),
        placeholder,
      ],
    }),
    attributes: {
      contenteditable: "true",
      role: "textbox",
      "aria-label": "Write your prompt",
      "aria-multiline": "true",
      class: "ProseMirror",
      id: "composer",
    },
  });
  return view;
}
