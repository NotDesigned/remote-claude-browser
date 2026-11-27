import { startClientGateway } from "./clients-main";
import { inputAckConfig, proxyInputConfig } from "./input/acks";
import { assertProductionSafe } from "./production-guard";

assertProductionSafe();
// An unknown MIRROR_INPUT_ACKS, MIRROR_SUBMIT_GUARD or MIRROR_PROXY_INPUT (or single-writer input
// without acks) stops the gateway here, not at first input.
inputAckConfig();
proxyInputConfig();
await startClientGateway();
