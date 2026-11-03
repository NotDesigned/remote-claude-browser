/**
 * rrweb 2.1.1's numeric canvas sampler creates a Worker from a string blob URL during record().
 * Documents that enforce Trusted Types for script URLs reject that constructor synchronously,
 * aborting the entire recorder before its first FullSnapshot. Probe the same capability before
 * enabling that optional sampler; the separate canvas WebRTC plugin does not depend on it.
 */
export function canStartCanvasSnapshotWorker(scope: typeof globalThis = globalThis): boolean {
  let url: string | undefined;
  try {
    // A document-start probe can precede origin commit. This optional sampler must not register
    // a Blob URL while loading or in an opaque origin; full-tab pixels and RTC are independent.
    if (
      scope.document?.readyState === "loading" ||
      scope.location?.origin === "null" ||
      typeof scope.Worker !== "function" ||
      typeof scope.Blob !== "function" ||
      typeof scope.URL?.createObjectURL !== "function" ||
      typeof scope.URL?.revokeObjectURL !== "function"
    ) {
      return false;
    }
    url = scope.URL.createObjectURL(
      new scope.Blob([""], { type: "text/javascript;charset=utf-8" }),
    );
    const worker = new scope.Worker(url);
    worker.terminate();
    return true;
  } catch {
    return false;
  } finally {
    if (url !== undefined) {
      try {
        scope.URL.revokeObjectURL(url);
      } catch {
        // Best-effort probe cleanup must not abort the main recorder either.
      }
    }
  }
}
