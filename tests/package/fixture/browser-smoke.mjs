import { NetworkDropDetector } from "unipls/drop-detectors";
import { runConsumerSmoke } from "./consumer-smoke.mjs";

const result = await runConsumerSmoke({ browser: true });
if (typeof NetworkDropDetector !== "function") {
  throw new Error("browser entryからNetworkDropDetectorをimportできませんでした。");
}

globalThis.uniplsSmokeResult = { checks: result.checks + 1 };
