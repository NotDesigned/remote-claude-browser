import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { BrowserHandle } from "../browser/launch";
import { registerClaudeChat } from "./routes";
import { buttonExpression } from "./extract";

function optionsFor(sid: string, profileDir: string, routePrefix = `/s/${sid}`) {
  const browser: BrowserHandle = {
    send: vi.fn(async (_session, method) =>
      method === "Page.createIsolatedWorld"
        ? { executionContextId: 42 }
        : {
            result: {
              value: {
                url: "https://claude.ai/new",
                title: `${sid} private`,
                ready: true,
                generating: false,
                messages: [],
                conversations: [],
              },
            },
          },
    ),
    onSessionEvent: () => () => undefined,
    onAttached: () => undefined,
    onDetached: () => undefined,
    onTargetInfoChanged: () => undefined,
    close: async () => undefined,
  };
  return {
    browser,
    profileDir,
    routePrefix,
    preHandler: async () => undefined,
    isOwner: (request: import("node:http").IncomingMessage) =>
      request.headers["x-test-owner"] === sid,
    mirrorHasController: () => false,
    targets: () => [{ targetId: `tab-${sid}`, sessionId: `cdp-${sid}`, type: "page" as const }],
    metadata: (tab: string) => ({
      targetId: tab,
      type: "page",
      url: "https://claude.ai/new",
      title: sid,
    }),
    documentId: () => 1,
  };
}

function openEvents(app: FastifyInstance, connectionKey: string) {
  return new Promise<{ body: string; statusCode: number }>((resolve, reject) => {
    app.inject(
      {
        url: `/s/client-1/api/claude/events?connectionKey=${connectionKey}`,
        headers: { "x-test-owner": "client-1" },
      },
      (error, response) => {
        if (error) reject(error);
        else if (response) resolve(response);
        else reject(new Error("SSE injection returned no response"));
      },
    );
  });
}

describe("session-prefixed Claude chat", () => {
  it("confirms a pending stop when the site's first stop click has no effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-stop-ready-"));
    const app = Fastify();
    const options = optionsFor("client-1", root);
    let stopClicks = 0;
    vi.mocked(options.browser.send).mockImplementation(async (_session, method, params) => {
      if (method !== "Runtime.evaluate") return {};
      if (params?.expression === buttonExpression("stop", true)) {
        stopClicks++;
        return { result: { value: true } };
      }
      return {
        result: {
          value: {
            url: "https://claude.ai/new",
            title: "Stop test",
            ready: true,
            generating: stopClicks < 2,
            messages: [],
            conversations: [],
          },
        },
      };
    });
    const chat = await registerClaudeChat(app, { ...options, takeControl: () => {} });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(address + "/s/client-1/api/claude/events?connectionKey=stop", {
        headers: { "x-test-owner": "client-1" },
      });
      reader = response.body!.getReader();
      let initialFrame = "";
      while (!initialFrame.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE ended before the initial snapshot");
        initialFrame += new TextDecoder().decode(chunk.value);
      }
      const initial = JSON.parse(initialFrame.split("\n\n")[0]!.slice(6));
      const action = {
        id: "11111111-1111-4111-8111-111111111111",
        type: "stop",
        controller: initial.controller,
        epoch: initial.state.epoch,
      };
      const stop = () =>
        app.inject({
          method: "POST",
          url: "/s/client-1/api/claude/action",
          headers: { "x-test-owner": "client-1" },
          payload: action,
        });
      expect((await stop()).json()).toMatchObject({ status: "confirmed" });
      expect(stopClicks).toBe(2);
      expect((await stop()).json()).toMatchObject({ status: "confirmed" });
      expect(stopClicks).toBe(2);
      expect(
        vi
          .mocked(options.browser.send)
          .mock.calls.some(([, method]) => method === "Input.insertText"),
      ).toBe(false);
    } finally {
      chat.close();
      await reader?.cancel();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a cold-page read before execution and restores a full snapshot after recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-cold-page-"));
    const app = Fastify();
    const options = optionsFor("client-1", root);
    const chat = await registerClaudeChat(app, { ...options, takeControl: () => {} });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(
        address + "/s/client-1/api/claude/events?connectionKey=cold-page",
        { headers: { "x-test-owner": "client-1" } },
      );
      reader = response.body!.getReader();
      let pending = "";
      const event = async (type: string): Promise<any> => {
        for (;;) {
          const separator = pending.indexOf("\n\n");
          if (separator >= 0) {
            const frame = pending.slice(0, separator);
            pending = pending.slice(separator + 2);
            if (frame.startsWith("data: ")) {
              const value = JSON.parse(frame.slice(6));
              if (value.type === type) return value;
            }
            continue;
          }
          const chunk = await reader!.read();
          if (chunk.done) throw new Error("SSE ended before recovery");
          pending += new TextDecoder().decode(chunk.value);
        }
      };
      const initial = await event("snapshot");
      const original = vi.mocked(options.browser.send).getMockImplementation()!;
      vi.mocked(options.browser.send).mockImplementation(async (session, method, params) => {
        if (method === "Runtime.evaluate") throw new Error("page still loading");
        return original(session, method, params);
      });
      const action = {
        id: "11111111-1111-4111-8111-111111111111",
        type: "send",
        controller: initial.controller,
        epoch: initial.state.epoch,
        text: "cold page regression",
      };
      const rejected = await app.inject({
        method: "POST",
        url: "/s/client-1/api/claude/action",
        headers: { "x-test-owner": "client-1" },
        payload: action,
      });
      expect(rejected.statusCode).toBe(503);
      expect(rejected.json()).toMatchObject({ status: "not-started", started: false });
      expect(
        vi
          .mocked(options.browser.send)
          .mock.calls.some(([, method]) => method === "Input.insertText"),
      ).toBe(false);
      expect(
        (
          await app.inject({
            url: `/s/client-1/api/claude/actions/${action.id}`,
            headers: { "x-test-owner": "client-1" },
          })
        ).json().status,
      ).toBe("not-started");
      const replay = await app.inject({
        method: "POST",
        url: "/s/client-1/api/claude/action",
        headers: { "x-test-owner": "client-1" },
        payload: action,
      });
      expect(replay.statusCode).toBe(503);
      await event("unavailable");
      vi.mocked(options.browser.send).mockImplementation(original);
      const recovered = await event("snapshot");
      expect(recovered.controller).toBe(initial.controller);
      expect(recovered.state.ready).toBe(true);
    } finally {
      chat.close();
      await reader?.cancel();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("lets a new page take control and terminates retired SSE retries without stealing it back", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-controller-takeover-"));
    const app = Fastify();
    const takeControl = vi.fn();
    const onControllerChange = vi.fn();
    const controller = await registerClaudeChat(app, {
      ...optionsFor("client-1", root),
      takeControl,
      onControllerChange,
    });
    const streams: Promise<{ body: string; statusCode: number }>[] = [];
    try {
      const first = openEvents(app, "page-one");
      streams.push(first);
      await vi.waitFor(() => expect(controller.hasController()).toBe(true));
      const second = openEvents(app, "page-two");
      streams.push(second);
      expect((await first).body).toContain('"type":"replaced"');
      expect(controller.hasController()).toBe(true);
      expect(takeControl).toHaveBeenCalledTimes(2);
      const retired = await openEvents(app, "page-one");
      expect(retired.statusCode).toBe(200);
      expect(retired.body).toContain('"type":"replaced"');
      expect(takeControl).toHaveBeenCalledTimes(2);
      expect(controller.hasController()).toBe(true);
      controller.disconnectController("replaced");
      expect((await second).body).toContain('"type":"replaced"');
      expect(controller.hasController()).toBe(false);
      expect((await openEvents(app, "page-two")).body).toContain('"type":"replaced"');
      const third = openEvents(app, "page-three");
      streams.push(third);
      await vi.waitFor(() => expect(takeControl).toHaveBeenCalledTimes(3));
      controller.disconnectController();
      expect((await third).body).not.toContain('"type":"replaced"');
      expect(onControllerChange).toHaveBeenCalledTimes(6);
      // The old page can be temporarily offline before another page takes over.
      const fourth = openEvents(app, "page-four");
      streams.push(fourth);
      await vi.waitFor(() => expect(takeControl).toHaveBeenCalledTimes(4));
      expect((await openEvents(app, "page-three")).body).toContain('"type":"replaced"');
      controller.disconnectController();
      await fourth;
      // A WS takeover must retire the chat page even if its SSE transport is already gone.
      controller.disconnectController("replaced");
      expect((await openEvents(app, "page-four")).body).toContain('"type":"replaced"');
    } finally {
      controller.close();
      await Promise.allSettled(streams);
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows transport retries with the same page key without retiring that page", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-same-page-retry-"));
    const app = Fastify();
    const takeControl = vi.fn();
    const controller = await registerClaudeChat(app, {
      ...optionsFor("client-1", root),
      takeControl,
    });
    const streams: Promise<{ body: string; statusCode: number }>[] = [];
    try {
      const first = openEvents(app, "same-page");
      streams.push(first);
      await vi.waitFor(() => expect(controller.hasController()).toBe(true));
      const second = openEvents(app, "same-page");
      streams.push(second);
      expect((await first).body).not.toContain('"type":"replaced"');
      expect(controller.hasController()).toBe(true);
      expect(takeControl).toHaveBeenCalledTimes(2);
      controller.disconnectController();
      expect((await second).statusCode).toBe(200);
      const retry = openEvents(app, "same-page");
      streams.push(retry);
      await vi.waitFor(() => expect(takeControl).toHaveBeenCalledTimes(3));
      controller.disconnectController("replaced");
      expect((await retry).body).toContain('"type":"replaced"');
    } finally {
      controller.close();
      await Promise.allSettled(streams);
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("disconnects a released controller without closing the slot and discards its late sample", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-controller-reuse-"));
    const app = Fastify();
    const options = optionsFor("client-1", root);
    let allowOld = true;
    options.isOwner = (request) => request.headers["x-test-owner"] === "new-owner" || allowOld;
    let resolveOld!: (value: unknown) => void;
    const oldSample = new Promise<unknown>((resolve) => {
      resolveOld = resolve;
    });
    const nativeSend = vi.mocked(options.browser.send).getMockImplementation()!;
    let blockedFirstSample = false;
    vi.mocked(options.browser.send).mockImplementation((session, method, params) => {
      if (method === "Runtime.evaluate" && !blockedFirstSample) {
        blockedFirstSample = true;
        return oldSample;
      }
      return nativeSend(session, method, params);
    });
    const controller = await registerClaudeChat(app, options);
    const responses: Promise<{ body: string; statusCode: number }>[] = [];
    const stream = (owner: string) =>
      new Promise<{ body: string; statusCode: number }>((resolve, reject) => {
        app.inject(
          { url: "/s/client-1/api/claude/events", headers: { "x-test-owner": owner } },
          (error, response) => {
            if (error) reject(error);
            else if (response) resolve(response);
            else reject(new Error("SSE injection returned no response"));
          },
        );
      });
    try {
      const first = stream("old-owner");
      responses.push(first);
      await vi.waitFor(() =>
        expect(
          vi
            .mocked(options.browser.send)
            .mock.calls.filter(([, method]) => method === "Runtime.evaluate"),
        ).toHaveLength(1),
      );
      controller.disconnectController();
      expect(controller.hasController()).toBe(false);
      allowOld = false;
      const second = stream("new-owner");
      responses.push(second);
      await vi.waitFor(() => expect(controller.hasController()).toBe(true));
      resolveOld({
        result: {
          value: {
            url: "https://claude.ai/new",
            title: "old secret",
            ready: true,
            generating: false,
            messages: [],
            conversations: [],
          },
        },
      });
      const metrics = await app.inject({ url: "/s/client-1/api/claude/metrics" });
      expect(metrics.json().connections).toBe(2);
      expect(controller.hasController()).toBe(true);
      controller.disconnectController();
      const [oldResponse, newResponse] = await Promise.all([first, second]);
      expect(oldResponse.statusCode).toBe(200);
      expect(oldResponse.body).not.toContain("old secret");
      expect(newResponse.statusCode).toBe(200);
      expect(newResponse.body).toContain("client-1 private");
      expect(newResponse.body).not.toContain("old secret");
    } finally {
      controller.close();
      resolveOld({ result: { value: { url: "https://claude.ai/new" } } });
      await Promise.allSettled(responses);
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps receipts and access checks separate for identical action IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-session-routes-"));
    const app = Fastify();
    const controllers: Awaited<ReturnType<typeof registerClaudeChat>>[] = [];
    try {
      for (const [sid, status] of [
        ["client-1", "confirmed"],
        ["client-2", "unknown"],
      ]) {
        const dir = join(root, sid!);
        await mkdir(dir);
        await writeFile(
          join(dir, "claude-actions.jsonl"),
          JSON.stringify({
            id: "same-action",
            digest: sid,
            status,
            updatedAt: 1,
          }) + "\n",
        );
        controllers.push(await registerClaudeChat(app, optionsFor(sid!, dir)));
      }
      const ownA = await app.inject({
        url: "/s/client-1/api/claude/actions/same-action",
        headers: { "x-test-owner": "client-1" },
      });
      const ownB = await app.inject({
        url: "/s/client-2/api/claude/actions/same-action",
        headers: { "x-test-owner": "client-2" },
      });
      expect(ownA.json()).toEqual({ id: "same-action", status: "confirmed" });
      expect(ownB.json()).toEqual({ id: "same-action", status: "unknown" });
      const crossed = await app.inject({
        url: "/s/client-2/api/claude/actions/same-action",
        headers: { "x-test-owner": "client-1" },
      });
      expect(crossed.statusCode).toBe(403);
      expect((await app.inject({ url: "/api/claude/actions/same-action" })).statusCode).toBe(404);
    } finally {
      for (const controller of controllers) controller.close();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows one independent SSE controller per prefix and confines duplicate-controller rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-session-streams-"));
    const app = Fastify();
    const a = await registerClaudeChat(app, optionsFor("client-1", root));
    const b = await registerClaudeChat(app, optionsFor("client-2", root));
    const stream = (sid: string) =>
      new Promise<{ body: string; statusCode: number }>((resolve, reject) => {
        app.inject(
          { url: `/s/${sid}/api/claude/events`, headers: { "x-test-owner": sid } },
          (error, response) => {
            if (error) reject(error);
            else if (response) resolve(response);
            else reject(new Error("SSE injection returned no response"));
          },
        );
      });
    const first = stream("client-1");
    const second = stream("client-2");
    try {
      await vi.waitFor(() => {
        expect(a.hasController()).toBe(true);
        expect(b.hasController()).toBe(true);
      });
      expect(
        (
          await app.inject({
            url: "/s/client-1/api/claude/events",
            headers: { "x-test-owner": "client-1" },
          })
        ).statusCode,
      ).toBe(409);
      const metricsA = await app.inject({ url: "/s/client-1/api/claude/metrics" });
      const metricsB = await app.inject({ url: "/s/client-2/api/claude/metrics" });
      expect(metricsA.json().connections).toBe(1);
      expect(metricsB.json().connections).toBe(1);
      a.close();
      b.close();
      const [responseA, responseB] = await Promise.all([first, second]);
      expect(responseA.statusCode).toBe(200);
      expect(responseB.statusCode).toBe(200);
      expect(responseA.body).toContain("tab-client-1");
      expect(responseA.body).not.toContain("tab-client-2");
      expect(responseB.body).toContain("tab-client-2");
      expect(responseB.body).not.toContain("tab-client-1");
    } finally {
      a.close();
      b.close();
      await Promise.allSettled([first, second]);
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves legacy URLs when no prefix is supplied and rejects unsafe prefix shapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-legacy-routes-"));
    const app = Fastify();
    const options = optionsFor("legacy", root, "");
    const controller = await registerClaudeChat(app, options);
    try {
      expect((await app.inject({ url: "/api/claude/metrics" })).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            url: "/api/claude/actions/missing",
            headers: { "x-test-owner": "legacy" },
          })
        ).json(),
      ).toEqual({ id: "missing", status: "unknown" });
      for (const routePrefix of ["//external", "relative", "/s/client-1/", "/s/client-1?other"]) {
        await expect(registerClaudeChat(app, { ...options, routePrefix })).rejects.toThrow(
          "routePrefix",
        );
      }
    } finally {
      controller.close();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lazily prepares a runtime before a direct text-chat page starts its SSE stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-direct-chat-runtime-"));
    const app = Fastify();
    const options = optionsFor("client-1", root);
    const ensureRuntime = vi.fn(async () => undefined);
    const controller = await registerClaudeChat(app, { ...options, ensureRuntime });
    const stream = openEvents(app, "direct-page");
    try {
      await vi.waitFor(() => expect(ensureRuntime).toHaveBeenCalledOnce());
      controller.close();
      const response = await stream;
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"type":"snapshot"');
    } finally {
      controller.close();
      await Promise.allSettled([stream]);
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("chat page takeover handling", () => {
  it("keeps its page key across network retries and stops all reconnects on a replaced terminal event", async () => {
    const nodes = new Map<
      string,
      { [key: string]: unknown; value: string; disabled: boolean; readOnly: boolean }
    >();
    const node = (id: string) => {
      if (!nodes.has(id))
        nodes.set(id, {
          value: "",
          disabled: false,
          readOnly: false,
          addEventListener: () => undefined,
        });
      return nodes.get(id)!;
    };
    const drafts = new Map([["remote-claude.draft.v1:client-1", "保留中文草稿"]]);
    const pending = new Map([["remote-claude.pending.v1:client-1", "pending-action"]]);
    const storage = (values: Map<string, string>) => ({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const sources: Source[] = [];
    class Source {
      closed = false;
      onerror?: () => void;
      onmessage?: (event: { data: string }) => void;
      constructor(readonly url: string) {
        sources.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    const retries: Array<() => void> = [];
    const setTimer = vi.fn((callback: () => void) => {
      retries.push(callback);
      return retries.length;
    });
    const clearTimer = vi.fn();
    const source = await readFile(new URL("../../../viewer/src/chat.js", import.meta.url), "utf8");
    new Script(source.replace(/^import .*;$/gm, "")).runInNewContext({
      document: {
        getElementById: node,
        createElement: () => node("pending-article"),
        addEventListener: () => undefined,
        documentElement: { dataset: {}, style: { setProperty: () => {} } },
      },
      window: { addEventListener: () => undefined },
      location: { search: "?sid=client-1&tab=owned-tab" },
      URLSearchParams,
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      crypto: { randomUUID: () => "stable-page-key" },
      EventSource: Source,
      localStorage: storage(drafts),
      sessionStorage: storage(pending),
      setTimeout: setTimer,
      clearTimeout: clearTimer,
      setInterval: () => 1,
      clearInterval: () => {},
    });
    expect(sources[0]?.url).toContain(
      "/s/client-1/api/claude/events?connectionKey=stable-page-key",
    );
    sources[0]?.onerror?.();
    retries[0]!();
    expect(sources).toHaveLength(2);
    expect(sources[1]?.url).toBe(sources[0]?.url);
    sources[1]?.onmessage?.({
      data: JSON.stringify({ type: "replaced", message: "另一页面已接管" }),
    });
    expect(sources[1]?.closed).toBe(true);
    expect(node("draft").value).toBe("保留中文草稿");
    expect(node("draft").readOnly).toBe(true);
    expect(node("send").disabled).toBe(true);
    expect(node("new-chat").disabled).toBe(true);
    expect(node("resolve-pending").disabled).toBe(true);
    expect(node("connection").textContent).toBe("已由另一页面接管");
    expect(clearTimer).toHaveBeenCalled();
    sources[1]?.onerror?.();
    retries[0]!();
    expect(setTimer).toHaveBeenCalledOnce();
    expect(sources).toHaveLength(2);
  });
});
