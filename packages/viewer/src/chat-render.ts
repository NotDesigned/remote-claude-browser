import katex from "katex";
import MarkdownIt from "markdown-it";
import "katex/dist/katex.min.css";

export interface ChatToken {
  kind: "text" | "inline" | "block" | "code";
  value: string;
}

function escaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

/** Keep incomplete streamed expressions as text until their closing delimiter arrives. */
export function tokenizeChatText(text: string): ChatToken[] {
  const tokens: ChatToken[] = [];
  const opening = /```|`|\$\$|\\\[|\\\(|\$/g;
  let cursor = 0;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    const start = match.index;
    const delimiter = match[0];
    if (escaped(text, start)) continue;
    const code = delimiter.startsWith("`");
    const block = delimiter === "$$" || delimiter === "\\[";
    const closing = delimiter === "\\[" ? "\\]" : delimiter === "\\(" ? "\\)" : delimiter;
    const contentStart = start + delimiter.length;
    if (delimiter === "$" && /\s|\$/.test(text[contentStart] ?? " ")) continue;
    let end = text.indexOf(closing, contentStart);
    while (
      end >= 0 &&
      (escaped(text, end) ||
        (delimiter === "$" && (/\s/.test(text[end - 1] ?? " ") || /\d/.test(text[end + 1] ?? ""))))
    ) {
      end = text.indexOf(closing, end + closing.length);
    }
    if (end < 0) continue;
    const value = text.slice(contentStart, end);
    if (!block && !code && value.includes("\n")) continue;
    if (start > cursor) tokens.push({ kind: "text", value: text.slice(cursor, start) });
    tokens.push({ kind: code ? "code" : block ? "block" : "inline", value });
    cursor = end + closing.length;
    opening.lastIndex = cursor;
  }
  if (cursor < text.length) tokens.push({ kind: "text", value: text.slice(cursor) });
  return tokens;
}

const markdown = new MarkdownIt({ html: false, linkify: false });
const formulas = new Map<string, string>();
let formulaBytes = 0;
markdown.inline.ruler.before("escape", "chat_math", (state, silent) => {
  const start = state.pos;
  const opening = state.src.slice(start).match(/^(\$\$|\$|\\\[|\\\()/)?.[0];
  if (!opening) return false;
  const token = tokenizeChatText(state.src.slice(start))[0];
  if (!token || (token.kind !== "inline" && token.kind !== "block")) return false;
  if (!silent) {
    const math = state.push(token.kind === "block" ? "chat_math_block" : "chat_math", "", 0);
    math.content = token.value;
  }
  state.pos += opening.length * 2 + token.value.length;
  return true;
});
for (const type of ["chat_math", "chat_math_block"]) {
  markdown.renderer.rules[type] = (tokens, index) => {
    const content = tokens[index]!.content.trim();
    const display = type === "chat_math_block";
    const key = `${type}:${content}`;
    const cached = formulas.get(key);
    if (cached) return cached;
    const html = `<span class="${display ? "math-block" : "math-inline"}">${katex.renderToString(
      content,
      {
        displayMode: display,
        throwOnError: false,
        trust: false,
        strict: "ignore",
        maxExpand: 1000,
        maxSize: 12,
      },
    )}</span>`;
    if (html.length < 32000) {
      while (formulas.size >= 128 || formulaBytes + html.length > 512000) {
        const first = formulas.keys().next().value;
        if (first === undefined) break;
        formulaBytes -= formulas.get(first)!.length;
        formulas.delete(first);
      }
      formulas.set(key, html);
      formulaBytes += html.length;
    }
    return html;
  };
}
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index]!.attrSet("target", "_blank");
  tokens[index]!.attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index]!;
  const href = String(token.attrGet("src") || "");
  const label = markdown.utils.escapeHtml(token.content || "图片");
  return markdown.validateLink(href)
    ? `<a href="${markdown.utils.escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : label;
};

interface RenderedBlock {
  html: string;
  nodes: Node[];
}
const rendered = new WeakMap<HTMLElement, RenderedBlock[]>();

/** Preserve existing text nodes and completed blocks while a streamed paragraph grows. */
function patchChildren(parent: Node, desired: Node[]): void {
  desired.forEach((next, index) => {
    const current = parent.childNodes[index];
    if (current === next) return;
    if (!current) {
      parent.appendChild(next);
      return;
    }
    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
      parent.replaceChild(next, current);
      return;
    }
    if (current.nodeType === 3) {
      const oldText = current.textContent || "",
        newText = next.textContent || "";
      let prefix = 0;
      while (prefix < oldText.length && oldText[prefix] === newText[prefix]) prefix++;
      if (prefix === oldText.length && prefix === newText.length) return;
      let suffix = 0;
      while (
        suffix < oldText.length - prefix &&
        suffix < newText.length - prefix &&
        oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]
      )
        suffix++;
      (current as Text).replaceData(
        prefix,
        oldText.length - prefix - suffix,
        newText.slice(prefix, newText.length - suffix),
      );
      return;
    }
    if (current.nodeType === 1) {
      const oldElement = current as Element,
        newElement = next as Element;
      for (const attribute of Array.from(oldElement.attributes))
        if (!newElement.hasAttribute(attribute.name)) oldElement.removeAttribute(attribute.name);
      for (const attribute of Array.from(newElement.attributes))
        if (oldElement.getAttribute(attribute.name) !== attribute.value)
          oldElement.setAttribute(attribute.name, attribute.value);
    }
    patchChildren(current, Array.from(next.childNodes));
  });
  while (parent.childNodes.length > desired.length) parent.lastChild!.remove();
}

export function renderChatText(element: HTMLElement, text: string, rich = true): void {
  if (!rich) {
    patchChildren(element, [element.ownerDocument.createTextNode(text)]);
    return;
  }
  const tokens = markdown.parse(text, {});
  const htmlBlocks: string[] = [];
  let start = 0,
    depth = 0;
  tokens.forEach((token, index) => {
    depth += token.nesting;
    if (depth === 0) {
      htmlBlocks.push(
        markdown.renderer.render(tokens.slice(start, index + 1), markdown.options, {}),
      );
      start = index + 1;
    }
  });
  const previous = rendered.get(element) || [];
  const plans = htmlBlocks.map((html, index) => {
    if (previous[index]?.html === html) return previous[index]!;
    const template = element.ownerDocument.createElement("template");
    template.innerHTML = html;
    return { html, nodes: Array.from(template.content.childNodes) };
  });
  const selection = element.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  let bookmark: { start: number; text: string } | undefined;
  if (
    range &&
    !range.collapsed &&
    element.contains(range.startContainer) &&
    element.contains(range.endContainer)
  ) {
    const prefix = range.cloneRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(range.startContainer, range.startOffset);
    bookmark = { start: prefix.toString().length, text: range.toString() };
  }
  patchChildren(
    element,
    plans.flatMap((block) => block.nodes),
  );
  if (bookmark && selection?.toString() !== bookmark.text) {
    const content = element.textContent || "";
    const start =
      content.slice(bookmark.start, bookmark.start + bookmark.text.length) === bookmark.text
        ? bookmark.start
        : content.indexOf(bookmark.text);
    if (start >= 0) {
      const restored = element.ownerDocument.createRange();
      const walker = element.ownerDocument.createTreeWalker(element, 4);
      let offset = 0,
        foundStart = false;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length || 0;
        if (!foundStart && offset + length >= start) {
          restored.setStart(node, start - offset);
          foundStart = true;
        }
        if (foundStart && offset + length >= start + bookmark.text.length) {
          restored.setEnd(node, start + bookmark.text.length - offset);
          selection?.removeAllRanges();
          selection?.addRange(restored);
          break;
        }
        offset += length;
      }
    }
  }
  let position = 0;
  rendered.set(
    element,
    plans.map((block) => {
      const nodes = Array.from(element.childNodes).slice(position, position + block.nodes.length);
      position += nodes.length;
      return { html: block.html, nodes };
    }),
  );
}
