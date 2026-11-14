/** Agent-side EME detection for P3-VIDEO. Media tracks still use the canvas RTC adapter. */

type RequestMediaKeySystemAccess = Navigator["requestMediaKeySystemAccess"];

interface NodeMirror {
  getId(node: Node): number;
}

export interface VideoDrmMonitorOptions {
  scope?: typeof globalThis;
  document?: Document;
  navigator?: Navigator;
  requestMediaKeySystemAccess?: RequestMediaKeySystemAccess;
  onBlocked(id?: number): void;
  onError?: (error: unknown) => void;
}

export interface VideoDrmMonitor {
  /** Pass this beside the RTC record plugin so encrypted events can be associated with rrweb ids. */
  plugin: {
    name: string;
    options: Record<string, never>;
    getMirror(mirrors: { nodeMirror: NodeMirror }): void;
  };
}

/** Capture this before page code gets an opportunity to replace the EME entry point. */
export function captureMediaKeySystemAccess(
  navigator: Navigator,
): RequestMediaKeySystemAccess | undefined {
  const request = navigator.requestMediaKeySystemAccess;
  return typeof request === "function" ? request : undefined;
}

function isVideoElement(value: EventTarget | null): value is HTMLVideoElement {
  const node = value as Node | null;
  return node?.nodeType === 1 && node.nodeName.toLowerCase() === "video";
}

export function installVideoDrmMonitor(options: VideoDrmMonitorOptions): VideoDrmMonitor {
  const scope = options.scope ?? globalThis;
  const document = options.document ?? scope.document;
  let mirror: NodeMirror | null = null;

  const encrypted = (event: Event) => {
    const target = isVideoElement(event.target) ? event.target : null;
    const id = target === null ? -1 : (mirror?.getId(target) ?? -1);
    options.onBlocked(id >= 0 ? id : undefined);
  };
  document.addEventListener("encrypted", encrypted, true);

  // Observing encrypted media is sufficient. Keep the native EME method untouched: wrappers
  // alter API identity on every page, including pages that only probe ClearKey support.

  return {
    plugin: {
      name: "@mirror/video-drm",
      options: {},
      getMirror(mirrors) {
        mirror = mirrors.nodeMirror;
      },
    },
  };
}
