// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { canStartCanvasSnapshotWorker } from "./canvas-snapshot";

function fixture(readyState = "complete", origin = "https://fixture.test") {
  const createBlob = vi.fn();
  const createWorker = vi.fn();
  const terminate = vi.fn();
  const createObjectURL = vi.fn(() => "blob:https://fixture.test/probe");
  const revokeObjectURL = vi.fn();
  class Blob {
    constructor(parts: unknown[], options: unknown) {
      createBlob(parts, options);
    }
  }
  class Worker {
    constructor(url: string) {
      createWorker(url);
    }
    terminate() {
      terminate();
    }
  }
  const scope = {
    document: { readyState },
    location: { origin },
    Blob,
    Worker,
    URL: { createObjectURL, revokeObjectURL },
  } as unknown as typeof globalThis;
  return { scope, createBlob, createWorker, terminate, createObjectURL, revokeObjectURL };
}

describe("optional canvas sampler capability probe", () => {
  it.each([
    ["loading", "https://fixture.test"],
    ["complete", "null"],
    ["interactive", "null"],
  ])("never registers a Blob in a %s document with origin %s", (readyState, origin) => {
    const probe = fixture(readyState, origin);
    expect(canStartCanvasSnapshotWorker(probe.scope)).toBe(false);
    expect(probe.createBlob).not.toHaveBeenCalled();
    expect(probe.createObjectURL).not.toHaveBeenCalled();
    expect(probe.createWorker).not.toHaveBeenCalled();
  });

  it.each(["interactive", "complete"])(
    "checks and cleans up a stable %s document",
    (readyState) => {
      const probe = fixture(readyState);
      expect(canStartCanvasSnapshotWorker(probe.scope)).toBe(true);
      expect(probe.createBlob).toHaveBeenCalledWith([""], {
        type: "text/javascript;charset=utf-8",
      });
      expect(probe.createObjectURL).toHaveBeenCalledOnce();
      expect(probe.createWorker).toHaveBeenCalledWith("blob:https://fixture.test/probe");
      expect(probe.terminate).toHaveBeenCalledOnce();
      expect(probe.revokeObjectURL).toHaveBeenCalledWith("blob:https://fixture.test/probe");
    },
  );

  it("returns false when Blob registration throws, without aborting the recorder", () => {
    const probe = fixture();
    probe.createObjectURL.mockImplementationOnce(() => {
      throw new Error("Origin not committed");
    });
    expect(canStartCanvasSnapshotWorker(probe.scope)).toBe(false);
    expect(probe.createWorker).not.toHaveBeenCalled();
    expect(probe.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("revokes a registered URL when the Worker constructor is rejected", () => {
    const probe = fixture();
    probe.createWorker.mockImplementationOnce(() => {
      throw new Error("CSP rejected worker");
    });
    expect(canStartCanvasSnapshotWorker(probe.scope)).toBe(false);
    expect(probe.revokeObjectURL).toHaveBeenCalledWith("blob:https://fixture.test/probe");
  });

  it("does not let cleanup failures escape into recorder initialization", () => {
    const probe = fixture();
    probe.revokeObjectURL.mockImplementationOnce(() => {
      throw new Error("Cleanup unavailable");
    });
    expect(canStartCanvasSnapshotWorker(probe.scope)).toBe(true);
    expect(probe.terminate).toHaveBeenCalledOnce();
  });
});
