/** Hosts the text-chat view inside the unified page and disposes it when the view changes. */
import { useEffect, useRef } from "preact/hooks";
import { mountChatView, type ChatViewStatus } from "./chat-view.js";

export interface ChatHostProps {
  sid: string;
  tab: string | null;
  connectionKey: string;
  onStatus(status: ChatViewStatus): void;
}

export function ChatHost({ sid, tab, connectionKey, onStatus }: ChatHostProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    return mountChatView(root, {
      sid,
      tab,
      connectionKey,
      onStatus: (status) => statusRef.current(status),
    });
    // The remote tab only seeds the chat target; a later tab change must not remount the chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, connectionKey]);
  return <div id="chat-view" ref={rootRef} />;
}
