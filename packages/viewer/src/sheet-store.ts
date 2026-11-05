/**
 * Keeps Claude's stylesheets on this device. They make up most of what a page load transfers, rarely
 * change, and are known by content hash, so a device that has them need not receive them again.
 * Losing them costs nothing but that, so every failure here just means starting without them.
 */
const DATABASE = "mirror-sheets";
const STORE = "sheets";
const READ_TIMEOUT_MS = 300;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const database = (): Promise<IDBDatabase> | null => {
  try {
    return typeof indexedDB === "undefined" ? null : openDatabase();
  } catch {
    return null;
  }
};

/** Null when this environment has no storage, so that callers need not wait for anything. */
export function loadStoredSheets(): Promise<[hash: string, text: string][]> | null {
  const opening = database();
  if (opening === null) return null;
  const reading = opening.then(
    (db) =>
      new Promise<[string, string][]>((resolve, reject) => {
        const store = db.transaction(STORE).objectStore(STORE);
        const keys = store.getAllKeys();
        const values = store.getAll();
        values.onsuccess = () =>
          resolve(keys.result.map((key, index) => [String(key), String(values.result[index])]));
        values.onerror = () => reject(values.error);
      }),
  );
  // A slow disk must not hold up the page: the gateway simply sends what was not offered.
  const timeout = new Promise<[string, string][]>((resolve) =>
    setTimeout(() => resolve([]), READ_TIMEOUT_MS),
  );
  return Promise.race([reading, timeout]).catch(() => []);
}

const write = (change: (store: IDBObjectStore) => void): void => {
  void database()
    ?.then((db) => change(db.transaction(STORE, "readwrite").objectStore(STORE)))
    .catch(() => undefined);
};

export function storeSheet(hash: string, text: string): void {
  write((store) => store.put(text, hash));
}

export function forgetSheet(hash: string): void {
  write((store) => store.delete(hash));
}

export function forgetAllSheets(): void {
  write((store) => store.clear());
}
