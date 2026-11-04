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
  /** Show the remote page, optionally opening a URL there first. */
  onOpenRemote?(url?: string): void;
}

/** Mounts the text chat into `root`; the returned function disposes it completely. */
export function mountChatView(root: HTMLElement, options: ChatViewOptions): () => void;
