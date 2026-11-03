/** Compact presence and driver controls outside the replay iframe. */
import type { PresenceEntry, Up } from "@mirror/protocol";

export interface PresenceProps {
  viewers: readonly PresenceEntry[];
  viewerId: string | null;
  driverId: string | null;
  send: (message: Up) => void;
}

export function Presence({ viewers, viewerId, driverId, send }: PresenceProps) {
  const isDriver = viewerId !== null && viewerId === driverId;
  return (
    <section
      id="presence-chrome"
      aria-label="连接的观看者"
      data-viewer-role={viewerId === null ? "pending" : isDriver ? "driver" : "follower"}
    >
      <ul>
        {viewers.map((viewer) => (
          <li
            key={viewer.id}
            data-viewer-id={viewer.id}
            data-driver={viewer.id === driverId ? "true" : "false"}
            title={viewer.id}
          >
            <span class="presence-name">
              {viewer.name}
              {viewer.id === viewerId ? "（你）" : ""}
            </span>
            {viewer.id === driverId && <span class="presence-driver">正在操作</span>}
          </li>
        ))}
      </ul>
      {viewerId !== null && !isDriver && (
        <button
          type="button"
          class="request-driver"
          onClick={() => send({ t: "driver-transfer", to: viewerId })}
        >
          请求操作权
        </button>
      )}
    </section>
  );
}
