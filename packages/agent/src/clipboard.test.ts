// @vitest-environment node
import { BINDING_NAME, ChunkReassembler } from "@mirror/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureClipboardWrite, installClipboardHooks } from "./clipboard";
import { createEmitter } from "./emit";

afterEach(() => vi.unstubAllGlobals());

class FakeWindow {
  private readonly copyListeners = new Map<string, Set<(event: CopyEventLike) => void>>();
  selection = "";

  addEventListener(type: "copy" | "cut" | "paste", listener: (event: CopyEventLike) => void): void {
    if (!this.copyListeners.has(type)) this.copyListeners.set(type, new Set());
    this.copyListeners.get(type)!.add(listener);
  }

  removeEventListener(
    type: "copy" | "cut" | "paste",
    listener: (event: CopyEventLike) => void,
  ): void {
    this.copyListeners.get(type)?.delete(listener);
  }

  getSelection(): { toString(): string } {
    return { toString: () => this.selection };
  }

  copy(event: CopyEventLike = {}): void {
    for (const listener of this.copyListeners.get("copy") ?? []) listener(event);
  }
}

interface CopyEventLike {
  clipboardData?: { getData(format: string): string } | null;
  target?: EventTarget | null;
}

describe("clipboard hooks", () => {
  it("virtualizes page clipboard writes and emits a private clip AgentMsg", async () => {
    const nativeWrite = vi.fn(async (_text: string) => undefined);
    const pageReplacement = vi.fn(async (_text: string) => undefined);
    const clipboard = { writeText: nativeWrite };
    const capturedWrite = captureClipboardWrite({ clipboard });

    // A page can replace the live method after the agent's first synchronous capture.
    clipboard.writeText = pageReplacement;
    const chunks: string[] = [];
    vi.stubGlobal("window", { [BINDING_NAME]: (payload: string) => chunks.push(payload) });
    const cleanup = installClipboardHooks({
      capturedWrite,
      emitter: createEmitter(77),
      window: new FakeWindow(),
    });

    await clipboard.writeText("copied by the server page");
    await Promise.resolve();

    expect(nativeWrite).not.toHaveBeenCalled();
    expect(pageReplacement).not.toHaveBeenCalled();
    const reassembler = new ChunkReassembler();
    expect(chunks.map((chunk) => reassembler.add(chunk)).filter(Boolean)).toEqual([
      { kind: "clip", docId: 77, text: "copied by the server page" },
    ]);
    cleanup();
  });

  it("with the native mask, replaces the prototype's methods and adds no own property", async () => {
    const { createContext, runInContext } = await import("node:vm");
    const context = createContext({});
    const win = runInContext("globalThis", context) as Window & typeof globalThis;
    const { installNativeMask } = await import("./native-mask");
    const mask = installNativeMask(win);
    const nativeWrite = vi.fn(async (_text: string) => undefined);
    class Clipboard {}
    Object.defineProperty(Clipboard.prototype, "writeText", {
      value: nativeWrite,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const clipboard = new Clipboard() as { writeText(text: string): Promise<void> };
    const before = Object.getOwnPropertyDescriptor(Clipboard.prototype, "writeText")!;
    const clips: string[] = [];
    const cleanup = installClipboardHooks({
      capturedWrite: captureClipboardWrite({ clipboard }),
      emitter: { emitClipboard: (text) => clips.push(text) },
      window: new FakeWindow(),
      mask,
    });
    expect(Reflect.ownKeys(clipboard)).toEqual([]);
    const after = Object.getOwnPropertyDescriptor(Clipboard.prototype, "writeText")!;
    expect({ ...after, value: undefined }).toEqual({ ...before, value: undefined });
    expect("prototype" in (after.value as object)).toBe(false);
    expect((after.value as () => void).name).toBe(nativeWrite.name);
    await clipboard.writeText("kept in the page");
    expect(nativeWrite).not.toHaveBeenCalled();
    expect(clips).toEqual(["kept in the page"]);
    cleanup();
    expect(Object.getOwnPropertyDescriptor(Clipboard.prototype, "writeText")).toEqual(before);
  });

  it("captures native copy while clearing the OS clipboard payload", () => {
    const view = new FakeWindow();
    view.selection = "native selection";
    const clips: string[] = [];
    const event = {
      clipboardData: { getData: vi.fn(() => ""), clearData: vi.fn() },
      preventDefault: vi.fn(),
    };
    const cleanup = installClipboardHooks({
      capturedWrite: null,
      emitter: { emitClipboard: (text) => clips.push(text) },
      window: view,
    });

    view.copy(event);

    expect(clips).toEqual(["native selection"]);
    expect(event.clipboardData.clearData).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    cleanup();
  });
  it("never reads another page's or the OS clipboard", async () => {
    const a = {
      writeText: vi.fn(async (_text: string) => {}),
      readText: vi.fn(async () => "OS secret"),
    };
    const b = {
      writeText: vi.fn(async (_text: string) => {}),
      readText: vi.fn(async () => "OS secret"),
    };
    const nativeRead = b.readText;
    const cleanups = [a, b].map((clipboard) =>
      installClipboardHooks({
        capturedWrite: captureClipboardWrite({ clipboard }),
        emitter: { emitClipboard: () => {} },
        window: new FakeWindow(),
      }),
    );
    await a.writeText("client A private");
    expect(await a.readText()).toBe("client A private");
    expect(await b.readText()).toBe("");
    expect(nativeRead).not.toHaveBeenCalled();
    cleanups.forEach((cleanup) => cleanup());
  });
});
