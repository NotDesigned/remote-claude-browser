/**
 * Delivers the remote page's focus reports (REMOTE_FOCUS_EVENT) from the replay to whoever handles
 * input for that Replayer. The report is applied with the replay, after the nodes it names exist.
 */
import {
  EventType,
  REMOTE_FOCUS_EVENT,
  isRemoteFocus,
  type eventWithTime,
  type RemoteFocus,
} from "@mirror/protocol";
import type { Replayer } from "@rrweb/replay";

type Listener = (focus: RemoteFocus) => void;
const listeners = new WeakMap<Replayer, Listener>();
const latest = new WeakMap<Replayer, RemoteFocus>();

export function remoteFocusOf(event: eventWithTime): RemoteFocus | null {
  if (event.type !== EventType.Custom || event.data.tag !== REMOTE_FOCUS_EVENT) return null;
  return isRemoteFocus(event.data.payload) ? event.data.payload : null;
}

/** The newest report among raw events, as pixel mode reads them without a replay. */
export function lastRemoteFocus(events: readonly eventWithTime[]): RemoteFocus | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const focus = remoteFocusOf(events[index]!);
    if (focus !== null) return focus;
  }
  return null;
}

export function remoteFocusReplay() {
  return {
    handler(event: eventWithTime, _isSync: boolean, { replayer }: { replayer: Replayer }) {
      const focus = remoteFocusOf(event);
      if (focus === null) return;
      latest.set(replayer, focus);
      listeners.get(replayer)?.(focus);
    },
  };
}

/** One listener per Replayer; it also hears the report applied before it subscribed. */
export function onRemoteFocus(replayer: Replayer, listener: Listener): () => void {
  listeners.set(replayer, listener);
  const known = latest.get(replayer);
  if (known !== undefined) listener(known);
  return () => {
    if (listeners.get(replayer) === listener) listeners.delete(replayer);
  };
}
