/**
 * The workspace around the mirror: who is signed in, their browser profiles, the links that open
 * a panel on arrival, and a CPA authorization waiting for its browser.
 */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { listAccounts, type AccountList } from "../accounts";
import { cpaApi, isCpaBrowserAuthorization, type CpaBrowserAuthorization } from "../network-api";
import { takeRemoteCcLink } from "../network-remote-cc-panel";
import { readJson, removeItem, removePrefixed, sessionArea, writeJson } from "../storage";
import { currentUser, logout, type FrontendUser } from "../users";
import type { PanelAction } from "./panels";

/** A CPA authorization waiting for the person to choose its browser. */
const CPA_BROWSER_KEY = "mirror-cpa-browser";

function useMountedRef() {
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

export interface WorkspaceUserOptions {
  /** A fixture page has no user. */
  fixturePath: string | null;
  /** The ready session whose profiles are listed, or null. */
  sid: string | null;
  /** Leaving the page (another user signed in, or signing out): stop the mirror first. */
  stop(): void;
  /** The user is not (or no longer) an admin. */
  onNotAdmin(): void;
}

export function useWorkspaceUser({ fixturePath, sid, stop, onNotAdmin }: WorkspaceUserOptions) {
  const mountedRef = useMountedRef();
  const [accountList, setAccountList] = useState<AccountList | null>(null);
  const [user, setUser] = useState<FrontendUser | null>(null);
  const [logoutPending, setLogoutPending] = useState(false);
  /** Signing out failed: shown in the ⋯ menu (or on the picker), where 退出登录 was pressed. */
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const latest = useRef({ stop, onNotAdmin });
  latest.current = { stop, onNotAdmin };

  // Only the newest request may answer: an older one (another session's) can finish after it.
  const accountRequests = useRef(0);
  const refreshAccounts = useCallback(() => {
    const request = ++accountRequests.current;
    if (sid === null) return;
    void listAccounts(sid)
      .then((list) => {
        if (mountedRef.current && request === accountRequests.current) setAccountList(list);
      })
      .catch(() => {
        // The menu keeps whatever it last showed.
      });
  }, [sid]);
  useEffect(refreshAccounts, [refreshAccounts]);

  /** The user this page loaded for: everything on it (session, profiles, panels) is theirs. */
  const loadedUserId = useRef<string | null>(null);
  const userRequests = useRef(0);
  const refreshUser = useCallback(() => {
    if (fixturePath !== null) return;
    const request = ++userRequests.current;
    // A 401 goes to the gate from the API client itself.
    void currentUser()
      .then((loaded) => {
        if (!mountedRef.current || request !== userRequests.current) return;
        // Another tab signed in as someone else: this page's session, profiles and panels belong
        // to the previous user, so start over as the new one.
        if (loadedUserId.current !== null && loadedUserId.current !== loaded.id) {
          latest.current.stop();
          window.location.reload();
          return;
        }
        loadedUserId.current = loaded.id;
        setUser(loaded);
        if (loaded.role !== "admin") latest.current.onNotAdmin();
      })
      .catch(() => {
        // The menu keeps the user it last showed.
      });
  }, [fixturePath]);
  useEffect(refreshUser, [refreshUser]);

  const signOut = async () => {
    if (logoutPending) return;
    setLogoutPending(true);
    setLogoutError(null);
    try {
      // An already expired sign-in counts as signed out.
      await logout();
      removePrefixed(sessionArea(), "mirror-cpa-");
      latest.current.stop();
      window.location.assign("/gate");
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "退出失败，请稍后重试。");
      setLogoutPending(false);
    }
  };

  return {
    user,
    refreshUser,
    accountList,
    refreshAccounts,
    signOut,
    logoutPending,
    logoutError,
    setLogoutError,
  };
}

/**
 * Links that open a panel once the user is known: /?remote-cc=ABCD-EFGH opens the remote-cc tab
 * with the code filled in, and /?account=linked (back from linking single sign-on) the account.
 */
export function useEntryLinks(
  user: FrontendUser | null,
  dispatchPanels: (action: PanelAction) => void,
) {
  const [remoteCcLink] = useState(() => takeRemoteCcLink(window.location.href));
  const remoteCcLinkOpened = useRef(false);
  const [accountLinked] = useState(
    () => new URL(window.location.href).searchParams.get("account") === "linked",
  );
  const accountLinkedShown = useRef(false);
  useEffect(() => {
    if (!user || !remoteCcLink || remoteCcLinkOpened.current) return;
    remoteCcLinkOpened.current = true;
    // Read the address again: the session may have rewritten it since the link was opened.
    const current = takeRemoteCcLink(window.location.href);
    if (current) window.history.replaceState(window.history.state, "", current.url);
    if (!remoteCcLink.code) return;
    dispatchPanels({ type: "open", panel: "network", networkTab: "remote-cc" });
  }, [user, remoteCcLink]);
  useEffect(() => {
    if (!user || !accountLinked || accountLinkedShown.current) return;
    accountLinkedShown.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("account");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    dispatchPanels({ type: "open", panel: "account" });
  }, [user, accountLinked]);
  return { remoteCcCode: remoteCcLink?.code || null, accountLinked };
}

export interface CpaBrowserAuthorizationOptions {
  userId: string | undefined;
  /** The ready session the authorization opens in, or null. */
  sid: string | null;
  accountList: AccountList | null;
  /** While the picker is open the person is still choosing the browser. */
  pickerOpen: boolean;
  /** The authorization could not open: show it on the CPA tab. */
  onFailed(): void;
}

/**
 * A CPA authorization waits (in this tab's storage, across the reload of a profile switch) until
 * the session runs in a profile behind its proxy, then opens there.
 */
export function useCpaBrowserAuthorization({
  userId,
  sid,
  accountList,
  pickerOpen,
  onFailed,
}: CpaBrowserAuthorizationOptions) {
  const mountedRef = useMountedRef();
  const [authorization, setAuthorization] = useState<CpaBrowserAuthorization | null>(() =>
    readJson(sessionArea(), CPA_BROWSER_KEY, isCpaBrowserAuthorization),
  );
  /** A CPA authorization could not open in its browser: shown on the CPA tab. */
  const [error, setError] = useState<string | null>(null);
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;
  const forget = () => {
    removeItem(sessionArea(), CPA_BROWSER_KEY);
    setAuthorization(null);
  };
  const choose = (chosen: CpaBrowserAuthorization) => {
    setError(null);
    writeJson(sessionArea(), CPA_BROWSER_KEY, chosen);
    setAuthorization(chosen);
  };
  useEffect(() => {
    if (!authorization || authorization.userId !== userId || pickerOpen || sid === null) return;
    const current = accountList?.accounts.find((account) => account.id === accountList.current);
    if (current?.proxyId !== authorization.proxyId) return;
    forget();
    void cpaApi
      .openOAuth(sid, authorization.instanceId, authorization.state)
      .catch((failure: Error) => {
        if (!mountedRef.current) return;
        setError(failure.message);
        onFailedRef.current();
      });
  }, [authorization, pickerOpen, sid, accountList, userId]);
  return { authorization, forget, choose, error, setError };
}
