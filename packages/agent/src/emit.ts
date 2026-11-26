/**
 * Chunked emission through the CDP binding.
 *
 * The binding is installed via Runtime.addBinding BEFORE this script runs (D1 attach order),
 * so in production the queue never fills. The retry queue exists so the bundle can also run in
 * a plain browser page with a stubbed/late `__mirror_emit` (the P0-AGENT acceptance test).
 *
 * A binding that never comes must not keep every event of a busy page. The queue keeps its first
 * message and drops the oldest after it: the numbers missing between them tell the gateway that
 * messages were lost (AgentLink), and it asks the page for a new snapshot.
 */
import { BINDING_NAME, encodeChunks, type AgentMsg } from "@mirror/protocol";

export interface Emitter {
  emit(msg: AgentMsg): void;
  /** Private agent-binding lane; converted to the frozen `clip` Down shape inside AgentLink. */
  emitClipboard(text: string): void;
  /** Private agent-binding lane for voice, carried like the clipboard. */
  emitVoice(message: object): void;
}

/** What waits for the binding at most, in messages and in UTF-16 units of their chunks. */
export const MAX_QUEUED_MESSAGES = 2_000;
export const MAX_QUEUED_CHARS = 32 * 1024 * 1024;

export type BindingFn = (payload: string) => void;

export interface RuntimeBindingHandle {
  get(): BindingFn | undefined;
}

export function createEmitter(
  docId: number,
  bindingHandle?: RuntimeBindingHandle,
  bindingName = BINDING_NAME,
): Emitter {
  let msgId = 0;
  /** Each waiting message's chunks, oldest first; null while the binding takes them directly. */
  let queue: string[][] | null = null;
  let queuedChars = 0;
  const size = (chunks: readonly string[]) =>
    chunks.reduce((total, chunk) => total + chunk.length, 0);

  const binding = (): BindingFn | null => {
    const retained = bindingHandle?.get();
    if (retained !== undefined) return retained;
    const scope = window as unknown as Record<string, unknown>;
    const fn = scope[bindingName];
    if (typeof fn !== "function") return null;
    const descriptor = Object.getOwnPropertyDescriptor(scope, bindingName);
    if (descriptor?.enumerable === true) {
      try {
        Object.defineProperty(scope, bindingName, { ...descriptor, enumerable: false });
      } catch {
        // Gateway acquisition repeats the same best-effort descriptor normalization.
      }
    }
    return fn as BindingFn;
  };

  const flushLater = () => {
    const timer = setInterval(() => {
      const fn = binding();
      if (fn === null) return;
      clearInterval(timer);
      const pending = queue ?? [];
      queue = null;
      queuedChars = 0;
      for (const chunks of pending) for (const chunk of chunks) fn(chunk);
    }, 200);
  };

  const send = (msg: unknown): void => {
    const chunks = encodeChunks(docId, msgId++, JSON.stringify(msg));
    const fn = binding();
    if (fn !== null && queue === null) {
      for (const chunk of chunks) fn(chunk);
      return;
    }
    if (queue === null) {
      queue = [];
      flushLater();
    }
    queue.push(chunks);
    queuedChars += size(chunks);
    // The first message stays, so that the gap after it shows; the newest stays, as the latest.
    while (
      queue.length > 2 &&
      (queue.length > MAX_QUEUED_MESSAGES || queuedChars > MAX_QUEUED_CHARS)
    ) {
      const [dropped] = queue.splice(1, 1);
      queuedChars -= size(dropped!);
    }
  };

  return {
    emit(msg: AgentMsg): void {
      send(msg);
    },
    emitClipboard(text: string): void {
      // AgentMsg is frozen, so this private binding message deliberately remains local to the
      // agent/browser bridge instead of widening the shared protocol package.
      send({ kind: "clip", docId, text });
    },
    emitVoice(message) {
      send({ kind: "voice", docId, ...message });
    },
  };
}
