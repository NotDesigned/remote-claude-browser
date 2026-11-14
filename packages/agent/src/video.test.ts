// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { captureMediaKeySystemAccess, installVideoDrmMonitor } from "./video";

function documentHarness() {
  let encrypted: ((event: Event) => void) | undefined;
  return {
    document: {
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === "encrypted") encrypted = listener as (event: Event) => void;
      },
    } as unknown as Document,
    encrypted: (target: EventTarget) => encrypted?.({ target } as Event),
  };
}

describe("agent video DRM monitor", () => {
  it("detects encrypted video events and reports the rrweb node id", () => {
    const h = documentHarness();
    const onBlocked = vi.fn();
    const video = { nodeType: 1, nodeName: "VIDEO" } as unknown as HTMLVideoElement;
    const monitor = installVideoDrmMonitor({
      document: h.document,
      navigator: {} as Navigator,
      onBlocked,
    });
    monitor.plugin.getMirror({ nodeMirror: { getId: (node) => (node === video ? 44 : -1) } });

    h.encrypted(video);

    expect(onBlocked).toHaveBeenCalledWith(44);
  });

  it("preserves the native EME method and reports only encrypted media events", async () => {
    const access = { keySystem: "org.example.keys" } as unknown as MediaKeySystemAccess;
    const original = vi.fn(async () => access);
    const navigator = { requestMediaKeySystemAccess: original } as unknown as Navigator;
    const onBlocked = vi.fn();
    installVideoDrmMonitor({
      document: documentHarness().document,
      navigator,
      requestMediaKeySystemAccess: captureMediaKeySystemAccess(navigator),
      onBlocked,
    });
    expect(navigator.requestMediaKeySystemAccess).toBe(original);
    await expect(navigator.requestMediaKeySystemAccess("org.example.keys", [])).resolves.toBe(
      access,
    );
    expect(onBlocked).not.toHaveBeenCalled();
  });
});
