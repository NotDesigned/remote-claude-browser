import type { PageLook, PageView } from "./page-look";

export interface ChatViewStatus {
  text: string;
  connected: boolean;
}

export interface ChatViewOptions {
  sid: string | null;
  tab?: string | null;
  /** Shared with this page's browser-view WebSocket so view switches are not takeovers. */
  connectionKey: string;
  onStatus?(status: ChatViewStatus): void;
  /** The conversation on show, for the address bar and tab. */
  onLocation?(location: { url: string; title: string }): void;
  /** Show the remote page, optionally opening a URL there first. */
  onOpenRemote?(url?: string): void;
  /** How the mirrored page looks, so chat can match it. */
  pageLook?: PageLook | null;
  /** Where the page was when the switch to chat happened. */
  pageView?: PageView | null;
}

/** Mounts the text chat into `root`; the returned function disposes it completely. */
export function mountChatView(root: HTMLElement, options: ChatViewOptions): () => void;
