/**
 * Recovery from 「输入未同步」.
 *
 * The gateway reports a tab as failed when the remote page did not take a whole-field sync. While
 * it is, Enter is dropped, and nothing but another successful sync clears it. The person's field
 * still holds the right text, so sending it again is usually all recovery needs: first on its
 * own, a couple of times with backoff, and then whenever the UI asks (「重新同步」).
 */
import { editableText, type TabId, type Up } from "@mirror/protocol";
import { deepActiveElement, isContenteditableEchoField, isValueEchoField } from "./keys";
import { isPasswordField } from "./password";

type ValueMessage = Extract<Up, { t: "value" }>;

/**
 * The focused mirror field's whole text as a `value` message, or null when no field that can be
 * synced this way has focus. Passwords are left out: their mirror holds a mask, not the text.
 */
export function focusedValueMessage(
  root: Document,
  tab: TabId,
  getNodeId: (node: Node) => number,
): ValueMessage | null {
  const active = deepActiveElement(root);
  if (active === null) return null;
  if (isContenteditableEchoField(active)) {
    let host: HTMLElement = active;
    while (host.parentElement !== null && isContenteditableEchoField(host.parentElement))
      host = host.parentElement;
    const nodeId = getNodeId(host);
    if (nodeId < 0) return null;
    const text = editableText(host);
    return { t: "value", tab, nodeId, value: text.trim() ? text : "", commit: false };
  }
  if (!isValueEchoField(active) || isPasswordField(active)) return null;
  const type = active.tagName.toLowerCase() === "input" ? active.type.toLowerCase() : "";
  if (type === "checkbox" || type === "radio" || type === "file") return null;
  const nodeId = getNodeId(active);
  if (nodeId < 0) return null;
  const message: ValueMessage = { t: "value", tab, nodeId, value: active.value, commit: false };
  if (typeof active.selectionStart === "number" && typeof active.selectionEnd === "number") {
    message.selectionStart = active.selectionStart;
    message.selectionEnd = active.selectionEnd;
  }
  return message;
}

export interface InputResyncOptions {
  /** The current value of the tab's focused field, or null when there is none. */
  valueFor(tab: TabId): ValueMessage | null;
  send(message: ValueMessage): void;
  /** Waits before each automatic try. Two tries: a page still busy gets a second, later one. */
  retryDelaysMs?: readonly number[];
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface InputResync {
  /** Feed every `input-status`. A failure starts the automatic tries; success stops them. */
  status(tab: TabId, failed: boolean): void;
  /** Send the focused field again now. False when there was nothing to send. */
  resync(tab: TabId): boolean;
  dispose(): void;
}

const DEFAULT_RETRY_DELAYS_MS = [400, 1_500];

export function createInputResync(options: InputResyncOptions): InputResync {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  /** Tabs in a failure episode, with the pending automatic try. */
  const episodes = new Map<TabId, { tries: number; timer: ReturnType<typeof setTimeout> | null }>();

  const resync = (tab: TabId): boolean => {
    const message = options.valueFor(tab);
    if (message === null) return false;
    options.send(message);
    return true;
  };

  const arm = (tab: TabId) => {
    const episode = episodes.get(tab);
    if (episode === undefined || episode.timer !== null || episode.tries >= delays.length) return;
    episode.timer = schedule(() => {
      episode.timer = null;
      episode.tries++;
      if (episodes.get(tab) !== episode) return;
      resync(tab);
      // The gateway repeats no unchanged failure, so the next try is armed from here.
      arm(tab);
    }, delays[episode.tries]!);
  };

  return {
    status(tab, failed) {
      const episode = episodes.get(tab);
      if (!failed) {
        if (episode?.timer != null) cancel(episode.timer);
        episodes.delete(tab);
        return;
      }
      if (episode === undefined) episodes.set(tab, { tries: 0, timer: null });
      arm(tab);
    },
    resync,
    dispose() {
      for (const episode of episodes.values()) if (episode.timer !== null) cancel(episode.timer);
      episodes.clear();
    },
  };
}
