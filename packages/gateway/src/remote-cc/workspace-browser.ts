/** remote-cc's view of a profile's running workspaces: where to open a sign-in, and its callback. */
import { evaluateInPage } from "../browser/evaluate";
import type { ClientRuntime } from "../session/client-runtime";
import type { SessionRuntimeRegistry } from "../session/runtime-registry";
import type { RemoteCcRouteOptions } from "./routes";

export function createRemoteCcBrowser(deps: {
  registry: Pick<SessionRuntimeRegistry<ClientRuntime>, "liveForProfile" | "isLive">;
  onlineSessions(): ReadonlySet<string>;
}): RemoteCcRouteOptions["browser"] {
  const { registry } = deps;
  return {
    // Prefer a session someone is viewing, so the user sees the sign-in tab.
    async open(profileId, url) {
      const live = registry.liveForProfile(profileId);
      const online = deps.onlineSessions();
      const [sid, runtime] = live.find(([sid]) => online.has(sid)) ?? live[0] ?? [];
      if (!sid || !runtime) return undefined;
      await runtime.tabs.handle({
        t: "nav",
        tab: runtime.tabs.activeTabId ?? "",
        action: "newtab",
        url,
      });
      return sid;
    },
    // The user may finish the sign-in in any of the profile's sessions.
    pageUrls(profileId) {
      return registry.liveForProfile(profileId).flatMap(([, runtime]) =>
        [...runtime.targets.values()]
          .filter((target) => target.type === "page")
          .map((target) => runtime.metadata.get(target.targetId)?.url)
          .filter((url): url is string => typeof url === "string"),
      );
    },
    // Callback pages strip the code from their address but show it as text.
    async pageTexts(profileId, origin) {
      const texts: string[] = [];
      for (const [, runtime] of registry.liveForProfile(profileId))
        for (const target of runtime.targets.values()) {
          const url = runtime.metadata.get(target.targetId)?.url;
          if (target.type !== "page" || !url || !url.startsWith(origin + "/")) continue;
          const value = await evaluateInPage(
            runtime.browser.send,
            target.sessionId,
            "document.body ? document.body.innerText : ''",
            "page text timed out",
          ).catch(() => undefined);
          if (typeof value === "string") texts.push(value.slice(0, 20_000));
        }
      return texts;
    },
    isLive: (sid) => registry.isLive(sid),
  };
}
