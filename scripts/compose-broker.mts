import { randomBytes } from "node:crypto";
import { startProfileBroker } from "../deploy/profile-broker.mjs";
import { createMihomoConfig } from "../packages/gateway/src/egress/mihomo";
import { validateProxy } from "../packages/gateway/src/egress/subscription";

const broker = await startProfileBroker({
  createConfig: createMihomoConfig,
  validateNode: validateProxy,
  geoUrl: process.env.SMOKE_GEO_URL,
  secret: randomBytes(32).toString("hex"),
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void broker.close().finally(() => process.exit(0)));
}
