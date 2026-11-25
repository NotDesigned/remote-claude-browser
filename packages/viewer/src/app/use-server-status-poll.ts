import type { ServerStatusMsg } from "@mirror/protocol";
import { useEffect, useState } from "preact/hooks";
import { pollServerStatus } from "../server-status";

/**
 * Server status while no mirror socket brings it (picking, starting, an error page). A refused
 * poll stops for good: the page is about to go to the gate, or has nothing to show it to. A new
 * `restartKey` (the session phase) polls again at once.
 */
export function useServerStatusPoll(
  enabled: boolean,
  sid: string | undefined,
  restartKey: string,
  onSample: (value: ServerStatusMsg) => void,
): void {
  const [authRejected, setAuthRejected] = useState(false);
  useEffect(() => {
    if (!enabled || authRejected) return;
    return pollServerStatus({
      sid,
      onSample,
      onAuthFailure: () => setAuthRejected(true),
    });
  }, [enabled, sid, restartKey, authRejected]);
}
