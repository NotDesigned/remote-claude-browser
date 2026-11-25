import { localArea, readItem, writeItem } from "../storage";

/** Preferences in localStorage; blocked or full storage just means no memory. */
export function viewStorage(): Pick<Storage, "getItem" | "setItem"> {
  return {
    getItem: (key) => readItem(localArea(), key),
    setItem: (key, value) => writeItem(localArea(), key, value),
  };
}
