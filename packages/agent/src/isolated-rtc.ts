/** Media peers belong to the gateway's isolated world, never the visited page's JS realm. */
import { captureRtcConstructors, installCanvasRtcRecord } from "./canvas-rtc";

export function createIsolatedRtc(options: {
  nodeFor(id: number): Node | null;
  signalBinding(): ((payload: string) => void) | undefined;
}) {
  const media = installCanvasRtcRecord({
    constructors: captureRtcConstructors(globalThis),
    signalBinding: options.signalBinding,
    exposeReceiver: false,
  });
  // The only MAIN-world round trip resolves an rrweb id to a DOM node. SDP/ICE and peer objects
  // remain in this world, whose native prototypes the site's scripts cannot replace.
  (
    media.plugin as unknown as {
      getMirror(mirror: { nodeMirror: { getNode(id: number): Node | null } }): void;
    }
  ).getMirror({ nodeMirror: { getNode: options.nodeFor } });
  return {
    receive: media.receiveSignal,
    videoBlocked: media.notifyVideoBlocked,
  };
}
