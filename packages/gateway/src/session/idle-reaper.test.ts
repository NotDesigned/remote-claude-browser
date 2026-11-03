import { describe, expect, it, vi } from "vitest";
import { createIdleReaper, type IdleSession } from "./idle-reaper";

function setup() {
  let at = 0;
  const token = {};
  let records: IdleSession[] = [{ sid: "client-1", token }];
  const online = new Set<string>();
  const busy = vi.fn(async () => false);
  const release = vi.fn(async (sid: string, expected: unknown) => {
    records = records.filter((record) => record.sid !== sid || record.token !== expected);
  });
  const onError = vi.fn();
  const reaper = createIdleReaper({
    sessions: () => records,
    isOnline: (sid) => online.has(sid),
    isBusy: busy,
    release,
    now: () => at,
    onError,
  });
  return {
    reaper,
    token,
    online,
    busy,
    release,
    onError,
    time: (value: number) => {
      at = value;
    },
    replace: (next: IdleSession[]) => {
      records = next;
    },
  };
}

describe("idle workspace reaper", () => {
  it("starts persisted offline records at startup and waits the full default grace period", async () => {
    const h = setup();
    await h.reaper.sweep();
    h.time(59_999);
    await h.reaper.sweep();
    expect(h.busy).not.toHaveBeenCalled();
    h.time(60_000);
    await h.reaper.sweep();
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledWith("client-1", h.token);
  });

  it("restarts the grace window after an observed online interval", async () => {
    const h = setup();
    await h.reaper.sweep();
    h.time(30_000);
    h.online.add("client-1");
    await h.reaper.sweep();
    h.online.clear();
    h.time(60_000);
    await h.reaper.sweep();
    h.time(119_999);
    await h.reaper.sweep();
    expect(h.release).not.toHaveBeenCalled();
    h.time(120_000);
    await h.reaper.sweep();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("defers a generating page without restarting its elapsed offline grace", async () => {
    const h = setup();
    await h.reaper.sweep();
    h.time(60_000);
    h.busy.mockResolvedValueOnce(true);
    await h.reaper.sweep();
    expect(h.release).not.toHaveBeenCalled();
    h.time(60_001);
    await h.reaper.sweep();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("coalesces overlapping sweeps and does not run duplicate releases", async () => {
    const h = setup();
    await h.reaper.sweep();
    h.time(60_000);
    let finish!: (busy: boolean) => void;
    h.busy.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const first = h.reaper.sweep();
    const second = h.reaper.sweep();
    expect(first).toBe(second);
    expect(h.busy).toHaveBeenCalledOnce();
    finish(false);
    await Promise.all([first, second]);
    await h.reaper.sweep();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("invalidates an awaited busy check on touch even if the reconnect already went offline again", async () => {
    const h = setup();
    await h.reaper.sweep();
    h.time(60_000);
    let finish!: (busy: boolean) => void;
    h.busy.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.reaper.sweep();
    h.reaper.touch("client-1");
    finish(false);
    await pending;
    expect(h.release).not.toHaveBeenCalled();
    await h.reaper.sweep();
    h.time(119_999);
    await h.reaper.sweep();
    expect(h.release).not.toHaveBeenCalled();
    h.time(120_000);
    await h.reaper.sweep();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("never releases a replacement owner after awaiting a check for the old record token", async () => {
    const h = setup();
    await h.reaper.sweep();
    h.time(60_000);
    let finish!: (busy: boolean) => void;
    h.busy.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.reaper.sweep();
    const replacement = {};
    h.replace([{ sid: "client-1", token: replacement }]);
    finish(false);
    await pending;
    expect(h.release).not.toHaveBeenCalled();
    await h.reaper.sweep();
    h.time(120_000);
    await h.reaper.sweep();
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledWith("client-1", replacement);
  });

  it("rechecks online state after a busy check and keeps failed releases eligible for retry", async () => {
    const h = setup();
    await h.reaper.sweep();
    h.time(60_000);
    h.busy.mockImplementationOnce(async () => {
      h.online.add("client-1");
      return false;
    });
    await h.reaper.sweep();
    expect(h.release).not.toHaveBeenCalled();
    h.online.clear();
    await h.reaper.sweep();
    h.time(120_000);
    const failure = new Error("close temporarily failed");
    h.release.mockRejectedValueOnce(failure);
    await h.reaper.sweep();
    expect(h.onError).toHaveBeenCalledWith(failure);
    h.time(120_001);
    await h.reaper.sweep();
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it("retains an eligible record after a failed busy check and cancels pending work on dispose", async () => {
    const h = setup();
    await h.reaper.sweep();
    h.time(60_000);
    const failure = new Error("renderer unavailable");
    h.busy.mockRejectedValueOnce(failure);
    await h.reaper.sweep();
    expect(h.onError).toHaveBeenCalledWith(failure);
    let finish!: (busy: boolean) => void;
    h.busy.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.reaper.sweep();
    h.reaper.dispose();
    finish(false);
    await pending;
    await h.reaper.sweep();
    expect(h.release).not.toHaveBeenCalled();
  });
});
