import { describe, expect, it } from "vitest";
import { assertProductionSafe, productionConfigErrors } from "./production-guard";

const secrets = { MIRROR_ACCESS_SECRET: "a".repeat(64), MIRROR_AUTH_SECRET: "b".repeat(64) };

describe("production guard", () => {
  it("ignores non-production environments", () => {
    expect(productionConfigErrors({ MIRROR_E2E: "1" })).toEqual([]);
    expect(productionConfigErrors({ NODE_ENV: "test", MIRROR_E2E: "1" })).toEqual([]);
  });

  it("accepts a production environment with stable secrets and no e2e mode", () => {
    expect(() => assertProductionSafe({ NODE_ENV: "production", ...secrets })).not.toThrow();
    expect(productionConfigErrors({ NODE_ENV: "production", MIRROR_E2E: "0", ...secrets })).toEqual(
      [],
    );
  });

  it("refuses e2e mode in production", () => {
    expect(() =>
      assertProductionSafe({ NODE_ENV: "production", MIRROR_E2E: "1", ...secrets }),
    ).toThrow(/MIRROR_E2E/);
  });

  it("refuses missing or short HMAC secrets in production", () => {
    const errors = productionConfigErrors({
      NODE_ENV: "production",
      MIRROR_ACCESS_SECRET: "",
      MIRROR_AUTH_SECRET: "short",
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/MIRROR_ACCESS_SECRET/);
    expect(errors[1]).toMatch(/MIRROR_AUTH_SECRET/);
  });
});
