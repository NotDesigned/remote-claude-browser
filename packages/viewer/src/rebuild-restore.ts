/**
 * Reusable state capture/restore around rrweb full-snapshot rebuilds.
 *
 * Phase-1 echo can register another hook in this collection. The built-in hook deliberately
 * captures only interaction state: focused editable, caret/selection, and non-zero scroll
 * positions. It does not copy page content across the trusted rrweb mirror boundary.
 *
 * The rebuilt document is the page as it is now, which need not be the page the capture saw: a
 * catch-up snapshot carries the deltas since, and an editor the page mounted anew (as a chat
 * composer is after sending) is another element, perhaps at another place. So the field is found
 * by its rrweb id first (the recorder keeps ids across snapshots of a document), then by its place,
 * then as the field the remote page reports focused, then as the one field that looks the same.
 * Someone typing is never left without a focused field, nor with the caret moved into the middle
 * of their text: a caret that cannot be put back goes to the end.
 */

interface ElementAddress {
  id: string | null;
  path: number[];
}

interface NodeAddress {
  path: number[];
}

interface InputSelection {
  kind: "input";
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
}

interface RangeSelection {
  kind: "range";
  anchor: NodeAddress;
  anchorOffset: number;
  focus: NodeAddress;
  focusOffset: number;
  /** rrweb ids of the anchor and focus nodes, when the replay knew them. */
  anchorId?: number;
  focusId?: number;
}

interface ScrollState {
  target: ElementAddress;
  left: number;
  top: number;
}

interface DocumentAddress {
  frames: ElementAddress[];
}

interface AddressedElement {
  document: DocumentAddress;
  element: ElementAddress;
}

interface DocumentScrollState {
  document: DocumentAddress;
  scrollX: number;
  scrollY: number;
  elements: ScrollState[];
}

/** What tells a field apart when it is no longer the same element. */
interface FieldSignature {
  tag: string;
  editable: boolean;
  role: string | null;
  label: string | null;
  placeholder: string | null;
}

interface InteractionState {
  active: AddressedElement | null;
  /** The focused field's rrweb id, when the replay knew it. */
  activeId: number | null;
  activeSignature: FieldSignature | null;
  /** The field's text, compared and dropped at restore; never written anywhere. */
  text?: string;
  /** The caret was collapsed at the end of that text. */
  caretAtEnd?: boolean;
  selection: InputSelection | RangeSelection | null;
  documents: DocumentScrollState[];
}

/** The replay's rrweb ids, which name the same page node across rebuilds of its document. */
export interface RestoreContext {
  /** The rrweb id of a replay node; negative when it has none. */
  getId?(node: Node): number;
  getNode?(id: number): Node | null;
  /** The field the remote page last reported focused, by rrweb id; null when none. */
  remoteFocusId?(): number | null;
}

export interface RebuildRestoreHook<State = unknown> {
  capture(iframe: HTMLIFrameElement, context?: RestoreContext): State | null;
  restore(iframe: HTMLIFrameElement, state: State, context?: RestoreContext): void;
}

interface CapturedHook {
  hook: RebuildRestoreHook<unknown>;
  state: unknown;
}

export type RebuildRestorePoint = CapturedHook[];

export class RebuildRestoreHooks {
  private readonly hooks: Array<RebuildRestoreHook<unknown>> = [];

  use<State>(hook: RebuildRestoreHook<State>): this {
    this.hooks.push(hook as RebuildRestoreHook<unknown>);
    return this;
  }

  capture(iframe: HTMLIFrameElement, context?: RestoreContext): RebuildRestorePoint {
    const captured: RebuildRestorePoint = [];
    for (const hook of this.hooks) {
      try {
        const state = hook.capture(iframe, context);
        if (state !== null) captured.push({ hook, state });
      } catch {
        // A page with an unusual DOM must not turn best-effort interaction restore into a resync.
      }
    }
    return captured;
  }

  restore(iframe: HTMLIFrameElement, point: RebuildRestorePoint, context?: RestoreContext): void {
    for (const { hook, state } of point) {
      try {
        hook.restore(iframe, state, context);
      } catch {
        // Other registered restore hooks still get their chance.
      }
    }
  }
}

function elementAddress(element: Element, document: Document): ElementAddress | null {
  const path: number[] = [];
  let current: Element | null = element;
  while (current !== document.documentElement) {
    const parent: Element | null = current.parentElement;
    if (parent === null) return null;
    const index = Array.prototype.indexOf.call(parent.children, current) as number;
    if (index < 0) return null;
    path.unshift(index);
    current = parent;
  }
  return { id: element.id || null, path };
}

function resolveElement(address: ElementAddress, document: Document): HTMLElement | null {
  if (address.id !== null) {
    const byId = document.getElementById(address.id);
    if (byId instanceof document.defaultView!.HTMLElement) return byId;
  }
  let current: Element = document.documentElement;
  for (const index of address.path) {
    const child = current.children.item(index);
    if (child === null) return null;
    current = child;
  }
  return current instanceof document.defaultView!.HTMLElement ? current : null;
}

function resolveDocument(address: DocumentAddress, root: Document): Document | null {
  let document = root;
  for (const frameAddress of address.frames) {
    const frame = resolveElement(frameAddress, document);
    if (frame === null || frame.tagName.toLowerCase() !== "iframe") return null;
    try {
      const child = (frame as HTMLIFrameElement).contentDocument;
      if (child === null) return null;
      document = child;
    } catch {
      return null;
    }
  }
  return document;
}

function walkDocuments(
  document: Document,
  address: DocumentAddress,
  visit: (document: Document, address: DocumentAddress) => void,
  seen = new Set<Document>(),
): void {
  if (seen.has(document)) return;
  seen.add(document);
  visit(document, address);
  for (const frame of document.querySelectorAll("iframe")) {
    const frameAddress = elementAddress(frame, document);
    if (frameAddress === null) continue;
    try {
      const child = frame.contentDocument;
      if (child !== null) {
        walkDocuments(child, { frames: [...address.frames, frameAddress] }, visit, seen);
      }
    } catch {
      // Cross-origin documents are not part of the same-origin replay document set.
    }
  }
}

function deepActiveElement(root: Document): Element | null {
  let document = root;
  let active: Element | null = null;
  const seen = new Set<Document>();
  while (!seen.has(document)) {
    seen.add(document);
    active = document.activeElement;
    if (active === null || active.tagName.toLowerCase() !== "iframe") break;
    try {
      const child = (active as HTMLIFrameElement).contentDocument;
      if (child === null) break;
      document = child;
    } catch {
      break;
    }
  }
  return active;
}

function nodeAddress(node: Node, root: Node): NodeAddress | null {
  const path: number[] = [];
  let current: Node | null = node;
  while (current !== root) {
    const parent: Node | null = current.parentNode;
    if (parent === null) return null;
    const index = Array.prototype.indexOf.call(parent.childNodes, current) as number;
    if (index < 0) return null;
    path.unshift(index);
    current = parent;
  }
  return { path };
}

function resolveNode(address: NodeAddress, root: Node): Node | null {
  let current = root;
  for (const index of address.path) {
    const child = current.childNodes.item(index);
    if (child === null) return null;
    current = child;
  }
  return current;
}

function isEditable(element: Element): element is HTMLElement {
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || (element as HTMLElement).isContentEditable;
}

/** A field that is still in a document and still takes typing. */
function usableField(node: Node | null | undefined): HTMLElement | null {
  if (node === null || node === undefined || node.nodeType !== 1) return null;
  if (node.isConnected === false || !isEditable(node as Element)) return null;
  return node as HTMLElement;
}

function signatureOf(element: HTMLElement): FieldSignature {
  const attribute = (name: string) => element.getAttribute?.(name) ?? null;
  return {
    tag: element.tagName.toLowerCase(),
    editable: element.isContentEditable === true,
    role: attribute("role"),
    label: attribute("aria-label"),
    placeholder: attribute("placeholder") ?? attribute("data-placeholder"),
  };
}

function sameSignature(a: FieldSignature, b: FieldSignature): boolean {
  return (
    a.tag === b.tag &&
    a.editable === b.editable &&
    a.role === b.role &&
    a.label === b.label &&
    a.placeholder === b.placeholder
  );
}

/** The one field in the documents that looks like the captured one; null for none or several. */
function fieldLike(root: Document, signature: FieldSignature): HTMLElement | null {
  let found: HTMLElement | null = null;
  let ambiguous = false;
  walkDocuments(root, { frames: [] }, (document) => {
    for (const element of document.querySelectorAll("input, textarea, [contenteditable]")) {
      const field = usableField(element);
      if (field === null || !sameSignature(signatureOf(field), signature)) continue;
      // The editing host, not an element inside it.
      if ((field.parentElement as HTMLElement | null)?.isContentEditable === true) continue;
      if (found !== null && found !== field) ambiguous = true;
      found = field;
    }
  });
  return ambiguous ? null : found;
}

function focusField(field: HTMLElement): void {
  try {
    field.focus({ preventScroll: true });
  } catch {
    field.focus();
  }
}

/** Typing goes on at the end of the text, never in the middle of it. */
function caretToEnd(field: HTMLElement): void {
  if ("setSelectionRange" in field) {
    const control = field as HTMLInputElement | HTMLTextAreaElement;
    const length = control.value?.length ?? 0;
    try {
      control.setSelectionRange(length, length);
    } catch {
      // Some input types have no selection.
    }
    return;
  }
  const selection = field.ownerDocument.getSelection?.();
  if (!selection) return;
  selection.selectAllChildren(field);
  selection.collapseToEnd();
}

function fieldText(field: HTMLElement): string {
  return "setSelectionRange" in field
    ? ((field as HTMLInputElement).value ?? "")
    : (field.textContent ?? "");
}

function caretAtEnd(field: HTMLElement): boolean {
  if ("setSelectionRange" in field) {
    const control = field as HTMLInputElement | HTMLTextAreaElement;
    const length = control.value?.length ?? 0;
    return control.selectionStart === length && control.selectionEnd === length;
  }
  const selection = field.ownerDocument.getSelection?.();
  if (!selection?.isCollapsed || !selection.focusNode) return false;
  try {
    const rest = field.ownerDocument.createRange();
    rest.setStart(selection.focusNode, selection.focusOffset);
    rest.setEnd(field, field.childNodes.length);
    return rest.toString().length === 0;
  } catch {
    return false;
  }
}

function nodeLength(node: Node): number {
  return node.nodeType === 3 || node.nodeType === 8
    ? (node.textContent?.length ?? 0)
    : node.childNodes.length;
}

function captureSelection(
  document: Document,
  active: HTMLElement,
  context?: RestoreContext,
): InputSelection | RangeSelection | null {
  if ("selectionStart" in active && "selectionEnd" in active) {
    const field = active as HTMLInputElement | HTMLTextAreaElement;
    if (field.selectionStart === null || field.selectionEnd === null) return null;
    return {
      kind: "input",
      start: field.selectionStart,
      end: field.selectionEnd,
      direction: field.selectionDirection ?? "none",
    };
  }

  const selection = document.getSelection();
  if (!selection?.anchorNode || !selection.focusNode) return null;
  const anchor = nodeAddress(selection.anchorNode, active);
  const focus = nodeAddress(selection.focusNode, active);
  if (anchor === null || focus === null) return null;
  const anchorId = context?.getId?.(selection.anchorNode) ?? -1;
  const focusId = context?.getId?.(selection.focusNode) ?? -1;
  return {
    kind: "range",
    anchor,
    anchorOffset: selection.anchorOffset,
    focus,
    focusOffset: selection.focusOffset,
    ...(anchorId >= 0 && focusId >= 0 ? { anchorId, focusId } : {}),
  };
}

/** True when the captured caret or selection was put back. */
function restoreSelection(
  document: Document,
  active: HTMLElement,
  state: InputSelection | RangeSelection,
  context?: RestoreContext,
): boolean {
  if (state.kind === "input") {
    if (!("setSelectionRange" in active)) return false;
    // A field clamps a range past its text to its end.
    (active as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(
      state.start,
      state.end,
      state.direction,
    );
    return true;
  }

  const within = (node: Node | null): Node | null =>
    node !== null && (node === active || active.contains(node)) ? node : null;
  let anchor: Node | null = null;
  let focus: Node | null = null;
  if (state.anchorId !== undefined && state.focusId !== undefined && context?.getNode) {
    anchor = within(context.getNode(state.anchorId));
    focus = within(context.getNode(state.focusId));
  }
  if (anchor === null || focus === null) {
    anchor = resolveNode(state.anchor, active);
    focus = resolveNode(state.focus, active);
  }
  if (anchor === null || focus === null) return false;
  const selection = document.getSelection();
  if (!selection) return false;
  selection.setBaseAndExtent(
    anchor,
    Math.min(state.anchorOffset, nodeLength(anchor)),
    focus,
    Math.min(state.focusOffset, nodeLength(focus)),
  );
  return true;
}

/** The captured field in the rebuilt documents, and whether it is the same element. */
function findField(
  root: Document,
  state: InteractionState,
  context?: RestoreContext,
): { field: HTMLElement; same: boolean } | null {
  if (state.active === null) return null;
  const byId = state.activeId === null ? null : usableField(context?.getNode?.(state.activeId));
  if (byId !== null) return { field: byId, same: true };
  const document = resolveDocument(state.active.document, root);
  const placed = usableField(
    document === null ? null : resolveElement(state.active.element, document),
  );
  if (
    placed !== null &&
    (state.activeSignature === null || sameSignature(signatureOf(placed), state.activeSignature))
  ) {
    // With rrweb ids at hand, a field in the same place with another id is another field.
    const placedId = context?.getId?.(placed) ?? -1;
    const same = state.activeId === null || placedId < 0 || placedId === state.activeId;
    return { field: placed, same };
  }
  const remoteId = context?.remoteFocusId?.() ?? null;
  const remote =
    remoteId === null || remoteId < 0 ? null : usableField(context?.getNode?.(remoteId));
  if (remote !== null) return { field: remote, same: false };
  const alike = state.activeSignature === null ? null : fieldLike(root, state.activeSignature);
  return alike === null ? null : { field: alike, same: false };
}

export const interactionRestoreHook: RebuildRestoreHook<InteractionState> = {
  capture(iframe, context) {
    const root = iframe.contentDocument;
    if (root === null || root.documentElement === null) return null;

    const activeElement = deepActiveElement(root);
    const active = activeElement !== null && isEditable(activeElement) ? activeElement : null;
    let activeAddress: AddressedElement | null = null;
    const documents: DocumentScrollState[] = [];
    walkDocuments(root, { frames: [] }, (document, address) => {
      const view = document.defaultView;
      if (view === null || document.documentElement === null) return;
      const elements: ScrollState[] = [];
      for (const element of document.querySelectorAll("*")) {
        if (element.scrollLeft === 0 && element.scrollTop === 0) continue;
        const target = elementAddress(element, document);
        if (target !== null) {
          elements.push({ target, left: element.scrollLeft, top: element.scrollTop });
        }
      }
      documents.push({
        document: address,
        scrollX: view.scrollX,
        scrollY: view.scrollY,
        elements,
      });
      if (active?.ownerDocument === document) {
        const element = elementAddress(active, document);
        if (element !== null) activeAddress = { document: address, element };
      }
    });

    const activeId = active === null ? -1 : (context?.getId?.(active) ?? -1);
    return {
      active: activeAddress,
      activeId: activeId >= 0 ? activeId : null,
      activeSignature: active === null ? null : signatureOf(active),
      ...(active === null ? {} : { text: fieldText(active), caretAtEnd: caretAtEnd(active) }),
      selection: active === null ? null : captureSelection(active.ownerDocument, active, context),
      documents,
    };
  },
  restore(iframe, state, context) {
    const root = iframe.contentDocument;
    if (root === null || root.documentElement === null) return;

    // Scroll positions first: focusing a field afterwards must not scroll the page anywhere.
    for (const documentState of state.documents) {
      const document = resolveDocument(documentState.document, root);
      const view = document?.defaultView;
      if (document === null || view === null || view === undefined) continue;
      for (const scroll of documentState.elements) {
        const element = resolveElement(scroll.target, document);
        element?.scrollTo({ left: scroll.left, top: scroll.top, behavior: "auto" });
      }
      view.scrollTo({
        left: documentState.scrollX,
        top: documentState.scrollY,
        behavior: "auto",
      });
    }

    const found = findField(root, state, context);
    if (found === null) return;
    focusField(found.field);
    // A caret typing at the end stays at the end when the rebuild brought text the replay lacked
    // (what the page received of that typing): put back at its old offset, the next keys would
    // land in the middle of the text.
    const keepsPlace =
      state.caretAtEnd !== true ||
      state.text === undefined ||
      fieldText(found.field) === state.text;
    const caretBack =
      found.same && state.selection !== null && keepsPlace
        ? restoreSelection(found.field.ownerDocument, found.field, state.selection, context)
        : false;
    if (!caretBack) caretToEnd(found.field);
  },
};

export function createRebuildRestoreHooks(): RebuildRestoreHooks {
  return new RebuildRestoreHooks().use(interactionRestoreHook);
}
