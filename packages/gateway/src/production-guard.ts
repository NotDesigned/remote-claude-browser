/**
 * Refuse to start a production gateway in a configuration that silently weakens security.
 *
 * - MIRROR_E2E disables the access gate entirely and exposes `/__e2e/evaluate`, which runs
 *   arbitrary JavaScript inside the logged-in remote page. It must never reach production.
 * - Without stable HMAC secrets every restart mints new keys, which logs out every device and
 *   (in multi-client mode) orphans the persisted session ownership records.
 */
const MIN_SECRET_LENGTH = 16;
const REQUIRED_SECRETS = ["MIRROR_ACCESS_SECRET", "MIRROR_AUTH_SECRET"] as const;

export function productionConfigErrors(env: NodeJS.ProcessEnv): string[] {
  if (env.NODE_ENV !== "production") return [];
  const errors: string[] = [];
  if (env.MIRROR_E2E !== undefined && env.MIRROR_E2E !== "" && env.MIRROR_E2E !== "0") {
    errors.push("MIRROR_E2E must not be set when NODE_ENV=production (it disables authentication)");
  }
  for (const name of REQUIRED_SECRETS) {
    const value = env[name] ?? "";
    if (value.length < MIN_SECRET_LENGTH) {
      errors.push(
        `${name} must be set to at least ${MIN_SECRET_LENGTH} characters when NODE_ENV=production (generate with: openssl rand -hex 32)`,
      );
    }
  }
  return errors;
}

export function assertProductionSafe(env: NodeJS.ProcessEnv = process.env): void {
  const errors = productionConfigErrors(env);
  if (errors.length > 0) {
    throw new Error(`Unsafe production configuration:\n- ${errors.join("\n- ")}`);
  }
}
