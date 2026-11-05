/**
 * @mirror/protocol — the stable shared contracts.
 *
 * This package contains types and pure cross-component helpers. Zero runtime dependencies
 * (`@rrweb/types` is type-level). Changes affect the agent, gateway, and viewer together and
 * therefore require a reviewed protocol change. Do not add anything here that is not a
 * cross-component contract.
 */
export * from "./rrweb";
export * from "./agent";
export * from "./chunk";
export * from "./wire";
export * from "./editable";
export * from "./sheets";
export * from "./voice";
