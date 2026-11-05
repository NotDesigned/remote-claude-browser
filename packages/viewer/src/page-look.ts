/**
 * What the chat view takes from the mirrored Claude page, so that moving from one to the other shows
 * as little change as possible: the page's fonts, icons and labels, and where it is scrolled to.
 *
 * Everything is read from the page rather than written down here. Claude's icons are glyphs of its
 * own font, its labels follow the account's language, and both change with Claude's releases.
 */

export interface LookRow {
  label: string;
  /** Null for a control that has no address of its own, such as Search. */
  href: string | null;
  glyph: string;
}

/** A part of the page, copied as plain positioned text and boxes, for a view that cannot act on it. */
export interface Replica {
  /** The copy has the page's colours, so it only suits the theme it was taken in. */
  theme: string;
  width: number;
  height: number;
  boxes: {
    x: number;
    y: number;
    w: number;
    h: number;
    radius: string;
    fill: string;
    line: string;
    shadow: string;
    clip: string;
  }[];
  images: { x: number; y: number; w: number; h: number; src: string; clip: string }[];
  texts: {
    x: number;
    y: number;
    text: string;
    size: string;
    weight: string;
    color: string;
    icon: boolean;
    /** How far the page lets it run before cutting it off. */
    width: number;
    transform: string;
  }[];
}

export interface PageLook {
  /** The page's own @font-face rules, whose files come through the asset proxy. */
  fonts: string;
  rows: LookRow[];
  wordmark: string;
  sidebarGlyph: string;
  modeGlyphs: string[];
  account: { initial: string; name: string; plan: string } | null;
  model: { name: string; effort: string } | null;
  mode: string;
  placeholder: string;
  disclaimer: string;
  sendGlyph: string;
  attachGlyph: string;
  /** The composer's other controls, such as dictation, which only work on the page. */
  composerControls: { glyph: string; width: number }[];
  copyGlyph: string;
  /** Icons at the end of the conversation rows, by conversation path. */
  conversationGlyphs: Record<string, string>;
  moreGlyph: string;
  recents: { label: string; caretGlyph: string; filterGlyph: string } | null;
  accountGlyphs: string[];
  /** The controls after Copy under a reply, such as Retry. */
  replyGlyphs: string[];
  projectGlyph: string;
  /** Claude's spark, as its path only. */
  spark: { viewBox: string; path: string; color: string } | null;
  /** Taken whenever the page is on its new-conversation screen. */
  newPage: { header: Replica; below: Replica; aboveFieldAt: number | null } | null;
}

export interface PageAnchor {
  /** The message's position in chat state: its transcript row when the page virtualizes. */
  message: number;
  /** How the block that starts the view begins; null to use the start of the message. */
  text: string | null;
  /** Where that block's top is, in pixels below the top of the page. */
  top: number;
}

export interface PageView {
  path: string;
  /** Null when the page is at the end of the conversation. */
  anchor: PageAnchor | null;
  /** Claude's side panel; null without one or with a document open in it. */
  panel: Replica | null;
  /** The controls beside the conversation's title. */
  header: Replica | null;
  titleGlyph: string;
}

const LOOK_KEY = "mirror.page-look";
const FONT_STYLE_ID = "chat-page-fonts";
const OWN_FONTS = /^"?anthropic/i;
const AT_END_PX = 80;
/** Claude's overview panel. A wider one holds an open document, which chat does not show. */
const MAX_PANEL_PX = 400;
const MIN_PANEL_PX = 200;
/** Claude's title bar lies over the top of its scroller. */
const HEADER_PX = 48;
const NEW_PAGE_CONTROLS_PX = 48;
const MESSAGE_SELECTOR =
  '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response';
const ROW_SELECTOR = '[data-testid="transcript-row"]';
/** Block elements that the chat view renders in the same order as the page. */
export const ANCHOR_BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, tr, pre, blockquote, hr";

interface Box {
  top: number;
  bottom: number;
}

/** Text identifies a block on both sides, where the two nest list items and paragraphs differently. */
export function blockStart(block: Element): string {
  return (block.textContent ?? "").replace(/\s+/g, "").slice(0, 16);
}

/** The first box still in view, which is the one whose position best describes the scroll. */
export function firstInView<T extends Box>(boxes: readonly T[], viewTop: number): T | null {
  return boxes.find((box) => box.bottom > viewTop) ?? null;
}

const text = (element: Element | null | undefined): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const glyphOf = (element: Element | null | undefined): string =>
  text(element?.querySelector('[data-cds="Icon"]'));

const pagePath = (href: string): string | null => {
  try {
    return new URL(href).pathname;
  } catch {
    return null;
  }
};

const isClear = (color: string): boolean =>
  /^rgba\(.*, 0\)$/.test(color) || /^color\(.* \/ 0\)$/.test(color) || color === "transparent";

export function readReplica(
  document: Document,
  theme: string,
  area: { left: number; top: number; right: number; bottom: number },
): Replica {
  const view = document.defaultView!;
  const replica: Replica = {
    theme,
    width: area.right - area.left,
    height: area.bottom - area.top,
    boxes: [],
    images: [],
    texts: [],
  };
  const inArea = (box: DOMRect): boolean =>
    box.width > 1 &&
    box.height > 1 &&
    box.left >= area.left &&
    box.top >= area.top &&
    box.right <= area.right &&
    box.bottom <= area.bottom;
  /** What the elements around this one leave visible, which is nothing for collapsed content. */
  const clipOf = (element: Element, box: DOMRect) => {
    const clip = { left: box.left, top: box.top, right: box.right, bottom: box.bottom, radius: "" };
    for (let around = element.parentElement; around; around = around.parentElement) {
      const style = view.getComputedStyle(around);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const edge = around.getBoundingClientRect();
      if (edge.left > clip.left || edge.right < clip.right || edge.top > clip.top) {
        clip.radius ||= style.borderRadius;
      }
      clip.left = Math.max(clip.left, edge.left);
      clip.top = Math.max(clip.top, edge.top);
      clip.right = Math.min(clip.right, edge.right);
      clip.bottom = Math.min(clip.bottom, edge.bottom);
    }
    return clip;
  };
  const place = (box: DOMRect) => ({
    x: Math.round(box.left - area.left),
    y: Math.round(box.top - area.top),
    w: Math.round(box.width),
    h: Math.round(box.height),
  });
  const clipPath = (box: DOMRect, clip: ReturnType<typeof clipOf>): string => {
    const inset = [
      clip.top - box.top,
      box.right - clip.right,
      box.bottom - clip.bottom,
      clip.left - box.left,
    ]
      .map((side) => `${Math.max(0, Math.round(side))}px`)
      .join(" ");
    return `inset(${inset}${clip.radius ? ` round ${clip.radius}` : ""})`;
  };
  const addBox = (box: DOMRect, style: CSSStyleDeclaration, clip: ReturnType<typeof clipOf>) => {
    const fill = isClear(style.backgroundColor) ? "" : style.backgroundColor;
    const line = parseFloat(style.borderTopWidth) > 0 ? style.borderTopColor : "";
    const shadow = style.boxShadow === "none" ? "" : style.boxShadow;
    if (fill || line || shadow)
      replica.boxes.push({
        ...place(box),
        radius: style.borderRadius,
        fill,
        line,
        shadow,
        clip: clipPath(box, clip),
      });
  };
  for (const element of Array.from(document.body.querySelectorAll("*"))) {
    const box = element.getBoundingClientRect();
    if (!inArea(box)) continue;
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const clip = clipOf(element, box);
    if (clip.right - clip.left < 2 || clip.bottom - clip.top < 2) continue;
    const style = view.getComputedStyle(element);
    addBox(box, style, clip);
    for (const pseudo of ["::before", "::after"]) {
      const layer = view.getComputedStyle(element, pseudo);
      if (layer.content !== "none" && layer.position === "absolute") addBox(box, layer, clip);
    }
    if (element.tagName === "IMG" && (element as HTMLImageElement).complete) {
      const { x, y, w, h } = place(box);
      replica.images.push({
        x,
        y,
        w,
        h,
        src: element.getAttribute("src") ?? "",
        clip: clipPath(box, clip),
      });
    }
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const textBox = range.getBoundingClientRect();
      const { x, y } = place(textBox);
      replica.texts.push({
        x,
        y,
        // Zero when it fits, as a copy in a slightly different font must not get cut for nothing.
        width: textBox.right > clip.right + 1 ? Math.round(clip.right - textBox.left) : 0,
        text: node.textContent.trim(),
        size: style.fontSize,
        weight: style.fontWeight,
        color: style.color,
        icon: element.getAttribute("data-cds") === "Icon",
        transform: [
          style.rotate === "none" ? "" : `rotate(${style.rotate})`,
          style.transform === "none" ? "" : style.transform,
        ]
          .join(" ")
          .trim(),
      });
    }
  }
  return replica;
}

function readFonts(document: Document): string {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let cssRules: CSSRuleList;
    try {
      cssRules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(cssRules)) {
      const face = rule as CSSFontFaceRule;
      if (face.type !== CSSRule.FONT_FACE_RULE) continue;
      if (OWN_FONTS.test(face.style.getPropertyValue("font-family"))) rules.push(face.cssText);
    }
  }
  return rules.join("\n");
}

function readRows(document: Document): LookRow[] {
  const rows: LookRow[] = [];
  // The fixed rows come first; the conversations and anything after them are not part of the look.
  for (const row of Array.from(document.querySelectorAll("[data-row-nav]"))) {
    const href = row.getAttribute("href");
    if (href !== null && pagePath(href)?.startsWith("/chat/")) break;
    const copy = row.cloneNode(true) as Element;
    copy.querySelectorAll('[data-cds="Shortcut"], [data-cds="Icon"]').forEach((el) => el.remove());
    const label = text(copy);
    if (label) rows.push({ label, href, glyph: glyphOf(row) });
  }
  return rows.slice(0, 12);
}

function findComposerBox(editor: Element): Element | null {
  const view = editor.ownerDocument.defaultView!;
  let box: Element | null = editor;
  while (box !== null && parseFloat(view.getComputedStyle(box).borderRadius) < 12) {
    box = box.parentElement;
  }
  return box;
}

function readNewPage(document: Document, composer: Element, greeting: Element, theme: string) {
  const box = composer.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  // Under the field on a wide page. On a phone the field is at the bottom, with the cards above it.
  const fieldLow = box.top > height / 2;
  const below = fieldLow
    ? {
        left: 0,
        top: greeting.getBoundingClientRect().bottom + 8,
        right: width,
        bottom: box.top - 8,
      }
    : {
        left: box.left - 8,
        top: box.bottom + NEW_PAGE_CONTROLS_PX,
        right: box.right + 8,
        bottom: height,
      };
  return {
    header: readReplica(document, theme, {
      left: width - 100,
      top: 0,
      right: width,
      bottom: HEADER_PX,
    }),
    below: readReplica(document, theme, below),
    /** Set when the copy stands at a fixed height over the field: its top in the page. */
    aboveFieldAt: fieldLow ? Math.round(below.top) : null,
  };
}

/** Null until the page has its sidebar and composer; a partial reading would replace a good one. */
export function readPageLook(
  document: Document,
  theme: string,
  previous: PageLook | null,
): PageLook | null {
  const editor = document.querySelector('[data-testid="chat-input"]');
  const found = readRows(document);
  if (editor === null || found.length === 0) return null;
  // The sidebar rebuilds in parts as the page loads; a row missing now is not gone.
  const rows = found.length < (previous?.rows.length ?? 0) ? previous!.rows : found;
  const model = document.querySelector('[data-testid="model-selector-dropdown"]');
  const buttons = Array.from(document.querySelectorAll("button"));
  const modelWords = Array.from(model?.querySelectorAll("span") ?? [])
    .filter((span) => span.children.length === 0)
    .map(text)
    .filter(Boolean);
  const account = document.querySelector('[data-testid="user-menu-button"]');
  const accountWords = Array.from(account?.querySelectorAll("span") ?? [])
    .filter((span) => span.children.length === 0 && !span.hasAttribute("data-cds"))
    .map(text)
    .filter((word) => word && word !== "·");
  const conversationGlyphs: Record<string, string> = {};
  for (const link of Array.from(document.querySelectorAll('a[href*="/chat/"]'))) {
    const path = pagePath(link.getAttribute("href") ?? "");
    // The icon sits beside the link in the row, as does the row's own menu button.
    const icon = Array.from(link.parentElement?.querySelectorAll('[data-cds="Icon"]') ?? []).find(
      (element) => element.closest("button") === null,
    );
    if (path && icon) conversationGlyphs[path] = text(icon);
  }
  const attach = document.querySelector('[data-testid="chat-input-attach"]');
  const composerControls =
    attach === null || model === null
      ? []
      : buttons
          .slice(
            buttons.indexOf(attach as HTMLButtonElement) + 1,
            buttons.indexOf(model as HTMLButtonElement),
          )
          .filter(
            (button) =>
              button.getAttribute("data-testid") !== "chat-input-send" &&
              button.querySelector("[data-picker-label]") === null,
          )
          .map((button) => ({
            glyph: glyphOf(button),
            width: Math.round(button.getBoundingClientRect().width),
          }))
          .filter(({ width }) => width > 1);
  const recents = document.querySelector('[data-row-key="label:recents"]');
  const copy = Array.from(document.querySelectorAll('button[aria-label="Copy"]')).pop();
  let replyRow = copy?.parentElement ?? null;
  while (replyRow && replyRow.querySelectorAll("button").length < 3) {
    replyRow = replyRow.parentElement;
  }
  const spark = document.querySelector('[data-cds="Spark"]');
  const sparkPath = spark?.querySelector("path")?.getAttribute("d");
  const greeting = document.querySelector("[data-new-page-greeting-text]");
  const composer = editor.closest('[data-cds="Composer"]') ?? findComposerBox(editor);
  return {
    fonts: readFonts(document),
    moreGlyph:
      glyphOf(
        document.querySelector('a[href*="/chat/"]')?.parentElement?.querySelector("button"),
      ) ||
      (previous?.moreGlyph ?? ""),
    recents:
      recents === null
        ? (previous?.recents ?? null)
        : {
            label: text(recents.querySelector("[data-group-name]")),
            caretGlyph: text(recents.querySelector("[data-group-caret]")),
            filterGlyph: glyphOf(recents.querySelector("[data-list-filter]")),
          },
    accountGlyphs: Array.from(
      account?.parentElement?.parentElement?.querySelectorAll('[data-cds="Icon"]') ?? [],
    )
      .map(text)
      .filter(Boolean),
    replyGlyphs: replyRow
      ? Array.from(replyRow.querySelectorAll("button")).slice(1).map(glyphOf).filter(Boolean)
      : (previous?.replyGlyphs ?? []),
    projectGlyph:
      glyphOf(document.querySelector("[data-picker-label]")?.closest("button")) ||
      (previous?.projectGlyph ?? ""),
    spark: sparkPath
      ? {
          viewBox: spark!.getAttribute("viewBox") ?? "0 0 100 100",
          path: sparkPath,
          color: spark!.getAttribute("fill") ?? "#d97757",
        }
      : (previous?.spark ?? null),
    newPage:
      greeting === null || composer === null
        ? (previous?.newPage ?? null)
        : readNewPage(document, composer, greeting, theme),
    rows,
    wordmark: text(document.querySelector("[data-app-wordmark]")),
    sidebarGlyph: glyphOf(document.querySelector('button[aria-keyshortcuts="Control+b"]')),
    modeGlyphs: Array.from(
      document.querySelectorAll('[data-cds="SegmentedControl"] [role="radio"]'),
    )
      .map(glyphOf)
      .filter(Boolean),
    account:
      account === null
        ? null
        : {
            initial: text(account.querySelector('[data-cds="Avatar"]')),
            name: accountWords[0] ?? "",
            plan: accountWords[1] ?? "",
          },
    model: model === null ? null : { name: modelWords[0] ?? "", effort: modelWords[1] ?? "" },
    mode: model === null ? "" : text(buttons[buttons.indexOf(model as HTMLButtonElement) + 1]),
    placeholder: editor.getAttribute("aria-placeholder") ?? "",
    disclaimer: text(
      Array.from(document.querySelectorAll("a")).find((link) =>
        link.closest('[data-testid="chat-input"]') ? false : /^Claude is AI/.test(text(link)),
      ),
    ),
    sendGlyph: glyphOf(document.querySelector('[data-testid="chat-input-send"]')),
    attachGlyph: glyphOf(attach),
    composerControls,
    copyGlyph: glyphOf(document.querySelector('button[aria-label="Copy"]')),
    conversationGlyphs,
  };
}

export function readPageView(document: Document, path: string, theme: string): PageView {
  const empty = { path, anchor: null, panel: null, header: null, titleGlyph: "" };
  const scroller = document.querySelector("[data-autoscroll-container]");
  if (scroller === null) return empty;
  const box = scroller.getBoundingClientRect();
  const pageWidth = document.documentElement.clientWidth;
  const pageHeight = document.documentElement.clientHeight;
  const width = pageWidth - box.right;
  const panel =
    width >= MIN_PANEL_PX && width <= MAX_PANEL_PX
      ? readReplica(document, theme, {
          left: box.right,
          top: HEADER_PX,
          right: pageWidth,
          bottom: pageHeight,
        })
      : null;
  // The first control after the title opens its menu; the rest stand at the far end of the bar.
  const controls = Array.from(document.querySelectorAll("button"))
    .filter((button) => {
      const { left, top, bottom, width } = button.getBoundingClientRect();
      return width > 1 && left >= box.left && top >= 0 && bottom <= HEADER_PX;
    })
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const headerStart = controls[1]?.getBoundingClientRect().right ?? pageWidth;
  const framing = {
    ...empty,
    panel,
    titleGlyph: glyphOf(controls[1]),
    header: readReplica(document, theme, {
      left: headerStart,
      top: 0,
      right: pageWidth,
      bottom: HEADER_PX,
    }),
  };
  const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < AT_END_PX;
  if (atEnd) return framing;

  const all = Array.from(document.querySelectorAll(MESSAGE_SELECTOR));
  const messages = all.filter((element) => !all.some((p) => p !== element && p.contains(element)));
  const visible = firstInView(
    messages.map((element, index) => {
      const { top, bottom } = element.getBoundingClientRect();
      return { element, index, top, bottom };
    }),
    box.top + HEADER_PX,
  );
  if (visible === null) return framing;
  const rowNumber = visible.element.closest(ROW_SELECTOR)?.getAttribute("data-index");
  const blocks = Array.from(visible.element.querySelectorAll(ANCHOR_BLOCKS)).filter(
    (block) => !block.closest('[class~="group/status"]'),
  );
  const first = firstInView(
    blocks.map((block) => {
      const { top, bottom } = block.getBoundingClientRect();
      return { block, top, bottom };
    }),
    box.top + HEADER_PX,
  );
  return {
    ...framing,
    anchor: {
      message: rowNumber ? Number(rowNumber) : visible.index,
      text: first ? blockStart(first.block) : null,
      top: (first ?? visible).top - box.top,
    },
  };
}

type LookStorage = Pick<Storage, "getItem" | "setItem">;

export function loadPageLook(storage: LookStorage): PageLook | null {
  try {
    const stored = storage.getItem(LOOK_KEY);
    return stored === null ? null : (JSON.parse(stored) as PageLook);
  } catch {
    return null;
  }
}

export function savePageLook(storage: LookStorage, look: PageLook): void {
  try {
    storage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch {
    // Without storage the chat view still has this look until the page reloads.
  }
}

/** Starts loading the fonts while the page view is still up, so chat opens with them ready. */
export function applyPageFonts(document: Document, fonts: string): void {
  let style = document.getElementById(FONT_STYLE_ID);
  if (style === null) {
    style = document.createElement("style");
    style.id = FONT_STYLE_ID;
    document.head.append(style);
  }
  if (style.textContent === fonts) return;
  style.textContent = fonts;
  for (const font of ["15px anthropic-sans", "15px anthropic-serif", "20px Anthropicons-Variable"])
    void document.fonts.load(font).catch(() => undefined);
}
