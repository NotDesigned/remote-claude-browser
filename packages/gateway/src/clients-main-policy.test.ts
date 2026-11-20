import { describe, expect, it } from "vitest";

import { ACCOUNT_IDLE_CLOSE_MS, SESSION_IDLE_GRACE_MS } from "./session/resource-policy";

describe("browser account resource policy", () => {
  it("keeps unused browser accounts for fifteen minutes", () => {
    expect(ACCOUNT_IDLE_CLOSE_MS).toBe(15 * 60_000);
  });

  it("keeps offline session pages for fifteen minutes", () => {
    expect(SESSION_IDLE_GRACE_MS).toBe(15 * 60_000);
  });
});
