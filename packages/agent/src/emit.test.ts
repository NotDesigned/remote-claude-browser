// @vitest-environment node
import { ChunkReassembler, type AgentMsg } from "@mirror/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createEmitter, MAX_QUEUED_CHARS, MAX_QUEUED_MESSAGES, type BindingFn } from "./emit";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** An emitter whose binding comes only when `ready` is called. */
function lateBinding() {
  vi.useFakeTimers();
  vi.stubGlobal("window", {});
  const payloads: string[] = [];
  let binding: BindingFn | undefined;
  const emitter = createEmitter(7, { get: () => binding });
  return {
    emitter,
    payloads,
    async ready() {
      binding = (payload) => payloads.push(payload);
      await vi.advanceTimersByTimeAsync(200);
    },
  };
}

const ids = (payloads: string[]) => payloads.map((payload) => Number(payload.split("|")[2]));

it("sends what waited for the binding, in order, once it comes", async () => {
  const { emitter, payloads, ready } = lateBinding();
  for (let i = 0; i < 3; i++)
    emitter.emit({ kind: "hello", docId: 7, url: `u${i}`, isTop: true, ts: i });
  expect(payloads).toEqual([]);
  await ready();
  expect(ids(payloads)).toEqual([0, 1, 2]);
  const reassembler = new ChunkReassembler();
  expect(
    payloads.map((payload) => (reassembler.add(payload) as AgentMsg & { url: string }).url),
  ).toEqual(["u0", "u1", "u2"]);
});

it("keeps the first and the latest messages when the binding never comes", async () => {
  const { emitter, payloads, ready } = lateBinding();
  const total = MAX_QUEUED_MESSAGES + 50;
  for (let i = 0; i < total; i++)
    emitter.emit({ kind: "hello", docId: 7, url: "", isTop: true, ts: i });
  await ready();
  const sent = ids(payloads);
  expect(sent).toHaveLength(MAX_QUEUED_MESSAGES);
  // The gap after the first message is what tells the gateway to ask for a new snapshot.
  expect(sent[0]).toBe(0);
  expect(sent[1]).toBe(total - MAX_QUEUED_MESSAGES + 1);
  expect(sent.at(-1)).toBe(total - 1);
});

it("drops whole messages, never part of one, to stay within its size", async () => {
  const { emitter, payloads, ready } = lateBinding();
  const big = "x".repeat(Math.floor(MAX_QUEUED_CHARS / 4));
  for (let i = 0; i < 6; i++)
    emitter.emit({ kind: "hello", docId: 7, url: big, isTop: true, ts: i });
  await ready();
  const reassembler = new ChunkReassembler();
  const complete = payloads
    .map((payload) => reassembler.add(payload))
    .filter((msg) => msg !== null);
  expect(reassembler.pendingCount).toBe(0);
  expect(complete.map((msg) => (msg as AgentMsg & { ts: number }).ts)).toEqual([0, 4, 5]);
});
