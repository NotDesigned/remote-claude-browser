/** Synchronous ownership of active pixel encoders, tracked independently per workspace. */
export interface PixelCapacityHolder {
  readonly sid: string;
  readonly tab: string;
}

export interface PixelCapacity {
  /** Repeated acquisition also fails; the controller retains its existing lease itself. */
  acquire(sid: string, tab: string): boolean;
  /** An unrelated/stale owner cannot release somebody else's tab. */
  release(sid: string, tab: string): void;
  holder(sid?: string): PixelCapacityHolder | undefined;
  available(): boolean;
  count(): number;
}

export function createPixelCapacity(
  options: { maxActive?: number; onChange?(holder: PixelCapacityHolder | undefined): void } = {},
): PixelCapacity {
  const occupied = new Map<string, PixelCapacityHolder>();
  const maxActive = options.maxActive ?? 1;
  return {
    acquire(sid, tab) {
      if (!sid || !tab) throw new TypeError("Pixel capacity requires a client and tab");
      if (occupied.has(sid) || occupied.size >= maxActive) return false;
      const holder = Object.freeze({ sid, tab });
      occupied.set(sid, holder);
      options.onChange?.(holder);
      return true;
    },
    release(sid, tab) {
      if (occupied.get(sid)?.tab !== tab) return;
      occupied.delete(sid);
      options.onChange?.(undefined);
    },
    holder: (sid) => (sid === undefined ? occupied.values().next().value : occupied.get(sid)),
    available: () => occupied.size < maxActive,
    count: () => occupied.size,
  };
}
