/**
 * Who a browser account is signed in to Claude as, for the configuration picker.
 *
 * A running browser answers from one of its own claude.ai pages, in a private world, with the
 * page's cookies and egress; the gateway never calls Claude itself. A stopped browser's cookie
 * database still tells whether its login cookie is there.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { BrowserHandle } from "../browser/launch";
import { isClaudeUrl } from "../browser/client-scope";

export interface ClaudeLogin {
  signedIn: boolean;
  email: string | null;
  unavailable?: boolean;
}

const ACCOUNT_WORLD = `_${randomBytes(8).toString("hex")}`;
const READ_LOGIN = `(location.origin === "https://claude.ai" ? fetch("/api/account", {
    credentials: "include", signal: AbortSignal.timeout(8000),
  })
  .then(async (response) => {
    if (response.status === 401) return { signedIn: false, email: null };
    const account = await response.json().catch(() => null);
    if (response.status === 403 && account?.error?.message === "account_banned")
      return { signedIn: false, email: null, unavailable: true };
    return response.ok ? account : null;
  })
  .then((account) => {
    if (account?.signedIn === false) return account;
    const email = account && (account.email_address ?? account.account?.email_address);
    return typeof email === "string" && email.trim() !== ""
      ? { signedIn: true, email } : null;
  })
  .catch(() => null) : Promise.resolve(null))`;

/** Undefined means the site could not be checked, rather than that the user signed out. */
export async function readClaudeLogin(
  browser: BrowserHandle,
  sessionTargets: ReadonlyMap<string, string>,
): Promise<ClaudeLogin | undefined> {
  if (!browser.sendBrowser) return undefined;
  const { targetInfos } = (await browser.sendBrowser("Target.getTargets")) as {
    targetInfos: { targetId: string; type: string; url: string }[];
  };
  for (const info of targetInfos) {
    if (info.type !== "page" || !isClaudeUrl(info.url)) continue;
    const session = [...sessionTargets].find(([, target]) => target === info.targetId)?.[0];
    if (!session) continue;
    try {
      const { frameTree } = (await browser.send(session, "Page.getFrameTree")) as {
        frameTree: { frame: { id: string } };
      };
      const world = (await browser.send(session, "Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: ACCOUNT_WORLD,
      })) as { executionContextId: number };
      const result = (await browser.send(session, "Runtime.evaluate", {
        contextId: world.executionContextId,
        expression: READ_LOGIN,
        awaitPromise: true,
        returnByValue: true,
        timeout: 10_000,
      })) as { result?: { value?: ClaudeLogin | null } };
      const login = result.result?.value;
      if (login?.signedIn === false)
        return {
          signedIn: false,
          email: null,
          ...(login.unavailable ? { unavailable: true } : {}),
        };
      if (login?.signedIn === true && typeof login.email === "string" && login.email.trim())
        return { signedIn: true, email: login.email };
    } catch {
      // A tab may be navigating or closing. Another tab can still answer.
    }
  }
  return undefined;
}

/** Account-owned state: a late request must never restore an email after logout or a switch. */
export function createClaudeLoginTracker(
  browser: BrowserHandle,
  sessionTargets: ReadonlyMap<string, string>,
  options: {
    email?: string | null;
    signedIn?: boolean;
    unavailable?: boolean;
    save(login: ClaudeLogin): Promise<void>;
  },
) {
  let state: ClaudeLogin | undefined;
  let observed = false;
  let generation = 0;
  let pending = false;
  let disposed = false;
  let checkedAt: number | undefined;
  const save = (login: ClaudeLogin) => void options.save(login).catch(() => {});
  return {
    current: () => state,
    observe(present: boolean, changed: boolean) {
      if (disposed) return;
      if (!observed || changed || !present) {
        generation++;
        state = {
          signedIn: present && !(!observed && (options.unavailable || options.signedIn === false)),
          email: present && !observed ? (options.email ?? null) : null,
          ...(!observed && present && options.unavailable ? { unavailable: true } : {}),
        };
        if (observed || !present) save(state);
        checkedAt = undefined;
      }
      observed = true;
      if (!present || pending || (checkedAt !== undefined && Date.now() - checkedAt < 60_000))
        return;
      const version = generation;
      pending = true;
      void readClaudeLogin(browser, sessionTargets)
        .then((login) => {
          if (disposed || generation !== version || login === undefined) return;
          state = login;
          checkedAt = Date.now();
          save(login);
        })
        .catch(() => {})
        .finally(() => (pending = false));
    },
    dispose() {
      disposed = true;
    },
  };
}

/** Chrome stores expiry in microseconds since 1601. */
const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000n;

/** Whether a stopped profile still holds an unexpired Claude login cookie. */
export function profileSignedIn(profileDir: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(profileDir, "Default", "Cookies"), { readOnly: true });
    const now = BigInt(Date.now()) * 1000n + CHROME_EPOCH_OFFSET_US;
    const row = db
      .prepare(
        `SELECT 1 FROM cookies WHERE name = 'sessionKey'
           AND (host_key = 'claude.ai' OR host_key LIKE '%.claude.ai')
           AND (expires_utc = 0 OR expires_utc > ?) LIMIT 1`,
      )
      .get(now);
    return row !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
