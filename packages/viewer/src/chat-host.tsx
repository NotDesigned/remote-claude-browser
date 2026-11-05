/** Hosts the text-chat view inside the unified page and disposes it when the view changes. */
import { useEffect, useRef } from "preact/hooks";
import { mountChatView, type ChatViewStatus } from "./chat-view.js";
import type { PageLook, PageView } from "./page-look";

export interface ChatHostProps {
  sid: string;
  tab: string | null;
  connectionKey: string;
  onStatus(status: ChatViewStatus): void;
  onOpenRemote(url?: string): void;
  onLocation(location: { url: string; title: string }): void;
  pageLook: PageLook | null;
  pageView: PageView | null;
}

export function ChatHost({
  sid,
  tab,
  connectionKey,
  onStatus,
  onOpenRemote,
  onLocation,
  pageLook,
  pageView,
}: ChatHostProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const openRemoteRef = useRef(onOpenRemote);
  openRemoteRef.current = onOpenRemote;
  const locationRef = useRef(onLocation);
  locationRef.current = onLocation;
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    return mountChatView(root, {
      sid,
      tab,
      connectionKey,
      onStatus: (status) => statusRef.current(status),
      onOpenRemote: (url) => openRemoteRef.current(url),
      onLocation: (location) => locationRef.current(location),
      pageLook,
      pageView,
    });
    // The remote tab only seeds the chat target; a later tab change must not remount the chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, connectionKey]);
  return <div id="chat-view" ref={rootRef} />;
}
