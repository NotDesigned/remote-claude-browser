import { describe, expect, it } from "vitest";
import { assertProductionSafe, productionConfigErrors } from "./production-guard";

const secret = { MIRROR_AUTH_SECRET: "b".repeat(64) };

describe("production guard", () => {
  it("ignores non-production environments", () => {
    expect(productionConfigErrors({ MIRROR_E2E: "1" })).toEqual([]);
    expect(productionConfigErrors({ NODE_ENV: "test", MIRROR_E2E: "1" })).toEqual([]);
  });

  it("accepts a production environment with a stable secret and no e2e mode", () => {
    expect(() => assertProductionSafe({ NODE_ENV: "production", ...secret })).not.toThrow();
    expect(productionConfigErrors({ NODE_ENV: "production", MIRROR_E2E: "0", ...secret })).toEqual(
      [],
    );
  });

  it("refuses e2e mode in production", () => {
    expect(() =>
      assertProductionSafe({ NODE_ENV: "production", MIRROR_E2E: "1", ...secret }),
    ).toThrow(/MIRROR_E2E/);
  });

  it.each([undefined, "short"])("refuses missing or short HMAC secrets: %s", (value) => {
    const errors = productionConfigErrors({
      NODE_ENV: "production",
      MIRROR_AUTH_SECRET: value,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/MIRROR_AUTH_SECRET/);
  });
});
