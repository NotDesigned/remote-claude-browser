import { startClientGateway } from "./clients-main";
import { inputAckConfig } from "./input/acks";
import { assertProductionSafe } from "./production-guard";

assertProductionSafe();
// An unknown MIRROR_INPUT_ACKS or MIRROR_SUBMIT_GUARD stops the gateway here, not at first input.
inputAckConfig();
await startClientGateway();
