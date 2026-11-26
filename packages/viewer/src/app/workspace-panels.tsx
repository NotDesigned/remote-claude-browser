/** The workspace panels over the shell: admin, account, mailboxes, and network & access. */
import { AccountPanel } from "../account-panel";
import { AdminPanel } from "../admin-panel";
import { MailboxPanel } from "../mailbox-panel";
import type { CpaBrowserAuthorization } from "../network-api";
import { NetworkPanel } from "../network-panel";
import type { FrontendUser } from "../users";
import { useEffect, useRef } from "preact/hooks";
import type { PanelAction, PanelState } from "./panels";

export interface WorkspacePanelsProps {
  user: FrontendUser;
  panels: PanelState;
  dispatchPanels(action: PanelAction): void;
  /** The page's client session, ready or not. */
  currentSid: string | undefined;
  /** The ready session and its profile's proxy, for the network panel. */
  browserSessionId: string | undefined;
  browserProxyId: string | null | undefined;
  remoteCcCode: string | null;
  /** Back from linking single sign-on. */
  accountLinked: boolean;
  /** A panel opened by an entry link was closed: its code or notice is not shown again. */
  onEntryLinkUsed(panel: "network" | "account"): void;
  authorizationError: string | null;
  onUserChanged(): void;
  /** A session was ended from the account panel. */
  onSessionEnded(sid: string): void;
  onChooseBrowser(authorization: CpaBrowserAuthorization): void;
}

export function WorkspacePanels({
  user,
  panels,
  dispatchPanels,
  currentSid,
  browserSessionId,
  browserProxyId,
  remoteCcCode,
  accountLinked,
  onEntryLinkUsed,
  authorizationError,
  onUserChanged,
  onSessionEnded,
  onChooseBrowser,
}: WorkspacePanelsProps) {
  // However a panel an entry link opened goes away (closed, or replaced by another), the link
  // has been used: its notice or code does not come back the next time the panel opens.
  const shown = useRef(panels.open);
  useEffect(() => {
    const previous = shown.current;
    shown.current = panels.open;
    if (previous !== panels.open && (previous === "account" || previous === "network"))
      onEntryLinkUsed(previous);
  }, [panels.open]);
  return (
    <>
      {panels.open === "admin" && user.role === "admin" && (
        <AdminPanel
          key={user.id}
          current={user}
          onClose={() => dispatchPanels({ type: "close", panel: "admin" })}
          onChanged={onUserChanged}
        />
      )}
      {panels.open === "account" && (
        <AccountPanel
          key={user.id}
          user={user}
          currentSid={currentSid}
          onClose={() => dispatchPanels({ type: "close", panel: "account" })}
          initialNotice={accountLinked ? "单点登录账号已绑定。" : undefined}
          onSessionEnded={onSessionEnded}
        />
      )}
      {panels.open === "mailboxes" && (
        <MailboxPanel
          key={user.id}
          onClose={() => dispatchPanels({ type: "close", panel: "mailboxes" })}
        />
      )}
      <NetworkPanel
        key={user.id}
        remoteCcCode={remoteCcCode}
        open={panels.open === "network"}
        error={authorizationError}
        tab={panels.networkTab}
        onTabChange={(tab) => dispatchPanels({ type: "network-tab", tab })}
        user={user}
        browserSessionId={browserSessionId}
        browserProxyId={browserProxyId}
        onClose={() => dispatchPanels({ type: "close", panel: "network" })}
        onOpenBrowser={() => dispatchPanels({ type: "browser-opened" })}
        onChooseBrowser={onChooseBrowser}
      />
    </>
  );
}
