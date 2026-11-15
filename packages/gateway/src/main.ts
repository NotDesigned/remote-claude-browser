import { startClientGateway } from "./clients-main";
import { assertProductionSafe } from "./production-guard";

assertProductionSafe();
await startClientGateway();
