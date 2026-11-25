import { useEffect, useRef, useState } from "preact/hooks";
import { failureMessage } from "./polling";

/**
 * At most one action at a time. `disabled={busy}` only takes effect after the next render, so a
 * fast double click or a second Enter would otherwise start the action twice.
 */
export interface InFlightGuard {
  readonly busy: boolean;
  /** Runs `action` unless one is already running; resolves false when it was skipped. */
  run(action: () => Promise<void>): Promise<boolean>;
}

export function createInFlightGuard(): InFlightGuard {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    async run(action) {
      if (busy) return false;
      busy = true;
      try {
        await action();
      } finally {
        busy = false;
      }
      return true;
    },
  };
}

export interface AsyncAction {
  busy: boolean;
  error: string | null;
  notice: string | null;
  setError(message: string | null): void;
  setNotice(message: string | null): void;
  /**
   * Clears both messages, runs `action` and shows its failure as the error. A second call while
   * one runs is ignored. Resolves false when the action failed or was skipped.
   */
  run(action: () => Promise<void>): Promise<boolean>;
}

export function useAsyncAction(): AsyncAction {
  const guard = useRef<InFlightGuard>(null as unknown as InFlightGuard);
  guard.current ??= createInFlightGuard();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    let failed = false;
    const ran = await guard.current.run(async () => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await action();
      } catch (failure) {
        failed = true;
        if (mounted.current) setError(failureMessage(failure, "操作失败，请重试。"));
      } finally {
        if (mounted.current) setBusy(false);
      }
    });
    return ran && !failed;
  };
  return { busy, error, notice, setError, setNotice, run };
}
