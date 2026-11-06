import type { AgentCmdInput, AgentMsg } from "@mirror/protocol";
import { describe, expect, it } from "vitest";

import type { AgentLink, CdpSend } from "../types";
import { resolveNode } from "./resolvenode";

describe("resolveNode", () => {
  it("keeps a same-process node on the top target without raw CDP correlation", async () => {
    const commands: { targetId: string; command: AgentCmdInput }[] = [];
    const agentLink: AgentLink = {
      async *msgs(): AsyncIterable<AgentMsg> {},
      async sendCmd(targetId, command) {
        commands.push({ targetId, command });
        return { reqId: 1, ok: true, data: { kind: "local" } };
      },
    };
    const sendCalls: unknown[] = [];

    await expect(
      resolveNode(
        {
          agentLink,
          send: async (...args) => {
            sendCalls.push(args);
            return {};
          },
          sessionFor: () => undefined,
        },
        "tab-1",
        42,
      ),
    ).resolves.toEqual({ targetId: "tab-1", localId: 42, frameHops: [] });
    expect(commands).toEqual([{ targetId: "tab-1", command: { cmd: "resolve", nodeId: 42 } }]);
    expect(sendCalls).toEqual([]);
  });

  it("reaches a frame in its parent's process through the parent's session, by frame id", async () => {
    const commands: { targetId: string; frameId: string | undefined }[] = [];
    const remote = (iframeNodeId: number, remoteId: number) => ({
      reqId: 1,
      ok: true,
      data: { kind: "remote", iframeNodeId, remoteId },
    });
    const agentLink: AgentLink = {
      async *msgs(): AsyncIterable<AgentMsg> {},
      async sendCmd(targetId, command, frameId) {
        commands.push({ targetId, frameId });
        const nodeId = (command as { nodeId: number }).nodeId;
        if (nodeId === 100) return remote(5, 60);
        if (nodeId === 60) return remote(6, 7);
        return { reqId: 1, ok: true, data: { kind: "local" } };
      },
    };
    const frameCalls: unknown[] = [];
    const frames: Record<number, string> = { 5: "outer-frame", 6: "inner-frame" };
    const objectFrames = new Map<string, string>();
    const node = (iframeNodeId: number) => {
      const objectId = `object-${objectFrames.size}`;
      objectFrames.set(objectId, frames[iframeNodeId]!);
      return { result: { objectId } };
    };
    const sessions: Record<string, string> = { tab: "tab-session", "outer-frame": "outer-session" };

    const resolved = await resolveNode(
      {
        agentLink,
        send: (async (_session: string, method: string, params: { objectId: string }) =>
          method === "DOM.describeNode"
            ? { node: { frameId: objectFrames.get(params.objectId) } }
            : {}) as unknown as CdpSend,
        callBridge: async (_session, _method, args) => node(args[0] as number),
        callFrame: async (session, frame, _method, args) => {
          frameCalls.push([session, frame, args[0]]);
          return node(args[0] as number);
        },
        // Only the tab and the outer frame have targets of their own.
        sessionFor: (id) => sessions[id],
      },
      "tab",
      100,
    );

    expect(resolved.targetId).toBe("outer-frame");
    expect(resolved.frameId).toBe("inner-frame");
    expect(resolved.localId).toBe(7);
    expect(resolved.frameHops.map((hop) => hop.childTargetId)).toEqual([
      "outer-frame",
      "inner-frame",
    ]);
    expect(frameCalls).toEqual([["outer-session", "outer-frame", 6]]);
    expect(commands).toEqual([
      { targetId: "tab", frameId: undefined },
      { targetId: "outer-frame", frameId: "outer-frame" },
      { targetId: "outer-frame", frameId: "inner-frame" },
    ]);
  });

  it("recurses across nested OOPIFs and looks up replacement sessions live", async () => {
    const sessions = new Map([
      ["tab-1", "top-session"],
      ["child-1", "child-old-session"],
      ["child-2", "grandchild-session"],
    ]);
    const commands: { targetId: string; command: AgentCmdInput }[] = [];
    const agentLink: AgentLink = {
      async *msgs(): AsyncIterable<AgentMsg> {},
      async sendCmd(targetId, command) {
        commands.push({ targetId, command });
        if (targetId === "tab-1") {
          return {
            reqId: 1,
            ok: true,
            data: { kind: "remote", iframeNodeId: 10, remoteId: 200 },
          };
        }
        if (targetId === "child-1") {
          sessions.set("child-1", "child-new-session");
          return {
            reqId: 2,
            ok: true,
            data: { kind: "remote", iframeNodeId: 20, remoteId: 30 },
          };
        }
        return { reqId: 3, ok: true, data: { kind: "local" } };
      },
    };
    const cdp: { sessionId: string; method: string; params?: Record<string, unknown> }[] = [];
    const send: CdpSend = async (sessionId, method, params) => {
      cdp.push({ sessionId, method, ...(params === undefined ? {} : { params }) });
      if (method === "Runtime.evaluate") return { result: { objectId: `${sessionId}-object` } };
      if (method === "DOM.describeNode") {
        return { node: { frameId: sessionId === "top-session" ? "child-1" : "child-2" } };
      }
      return {};
    };

    await expect(
      resolveNode(
        { agentLink, send, sessionFor: (targetId) => sessions.get(targetId) },
        "tab-1",
        900,
      ),
    ).resolves.toEqual({
      targetId: "child-2",
      localId: 30,
      frameHops: [
        { targetId: "tab-1", iframeNodeId: 10, childTargetId: "child-1" },
        { targetId: "child-1", iframeNodeId: 20, childTargetId: "child-2" },
      ],
    });
    expect(commands).toEqual([
      { targetId: "tab-1", command: { cmd: "resolve", nodeId: 900 } },
      { targetId: "child-1", command: { cmd: "resolve", nodeId: 200 } },
      { targetId: "child-2", command: { cmd: "resolve", nodeId: 30 } },
    ]);
    expect(cdp.map(({ sessionId, method }) => ({ sessionId, method }))).toEqual([
      { sessionId: "top-session", method: "Runtime.evaluate" },
      { sessionId: "top-session", method: "DOM.describeNode" },
      { sessionId: "top-session", method: "Runtime.releaseObject" },
      { sessionId: "child-new-session", method: "Runtime.evaluate" },
      { sessionId: "child-new-session", method: "DOM.describeNode" },
      { sessionId: "child-new-session", method: "Runtime.releaseObject" },
    ]);
  });

  it("surfaces an unresolved node and a detached correlated child", async () => {
    const unresolved: AgentLink = {
      async *msgs(): AsyncIterable<AgentMsg> {},
      async sendCmd() {
        return { reqId: 1, ok: false, err: "node not found" };
      },
    };
    await expect(
      resolveNode(
        { agentLink: unresolved, send: async () => ({}), sessionFor: () => "session" },
        "tab",
        1,
      ),
    ).rejects.toThrow("node not found");

    const remote: AgentLink = {
      async *msgs(): AsyncIterable<AgentMsg> {},
      async sendCmd() {
        return {
          reqId: 1,
          ok: true,
          data: { kind: "remote", iframeNodeId: 2, remoteId: 3 },
        };
      },
    };
    const send: CdpSend = async (_sessionId, method) =>
      method === "Runtime.evaluate"
        ? { result: { objectId: "iframe-object" } }
        : method === "DOM.describeNode"
          ? { node: { frameId: "detached-child" } }
          : {};
    await expect(
      resolveNode(
        {
          agentLink: remote,
          send,
          sessionFor: (targetId) => (targetId === "tab" ? "top-session" : undefined),
        },
        "tab",
        1,
      ),
    ).rejects.toThrow("OOPIF child target detached-child is not attached");
  });
});
