/**
 * Guarded Web Storage. Reading `window.sessionStorage` itself throws when site data is blocked, and
 * any stored value may be stale or written by another version: every access here fails soft.
 */
export type StorageArea = Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
  readonly length?: number;
  key?(index: number): string | null;
};

const memoryless: StorageArea = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

/** The page's sessionStorage, or a store that remembers nothing when it is unavailable. */
export function sessionArea(): StorageArea {
  try {
    return window.sessionStorage ?? memoryless;
  } catch {
    return memoryless;
  }
}

/** The page's localStorage, or a store that remembers nothing when it is unavailable. */
export function localArea(): StorageArea {
  try {
    return window.localStorage ?? memoryless;
  } catch {
    return memoryless;
  }
}

export function readItem(area: StorageArea, key: string): string | null {
  try {
    return area.getItem(key);
  } catch {
    return null;
  }
}

export function writeItem(area: StorageArea, key: string, value: string): void {
  try {
    area.setItem(key, value);
  } catch {
    // Full or blocked: the value is only a convenience.
  }
}

export function removeItem(area: StorageArea, key: string): void {
  try {
    area.removeItem(key);
  } catch {
    // Blocked: nothing was stored either.
  }
}

/** A stored JSON value that `accept` recognises, or null (missing, unparsable or the wrong shape). */
export function readJson<T>(
  area: StorageArea,
  key: string,
  accept: (value: unknown) => value is T,
): T | null {
  const raw = readItem(area, key);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return accept(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeJson(area: StorageArea, key: string, value: unknown): void {
  writeItem(area, key, JSON.stringify(value));
}

/** Removes every key that starts with `prefix`. */
export function removePrefixed(area: StorageArea, prefix: string): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < (area.length ?? 0); index++) {
      const key = area.key?.(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) area.removeItem(key);
  } catch {
    // Blocked: there is nothing to clear.
  }
}
