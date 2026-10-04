import { describe, expect, it } from "vite-plus/test";

import * as detectors from "../../src/drop-detectors.ts";
import * as unipls from "../../src/index.ts";

describe("drop detector の公開境界", () => {
  /**
   * ```ts
   * import { HeartbeatDropDetector, NetworkDropDetector } from "unipls/drop-detectors";
   * // NetworkDropDetector は setup 時まで window に触れない
   * ```
   */
  it("drop detector を専用entry pointに分離し、rootをcoreに保つ", () => {
    expect(detectors.HeartbeatDropDetector).toBeTypeOf("function");
    expect(detectors.NetworkDropDetector).toBeTypeOf("function");

    const rootHasDetector: "HeartbeatDropDetector" extends keyof typeof unipls ? true : false =
      false;
    const rootHasReconnector: "ImmediateReconnector" extends keyof typeof unipls ? true : false =
      false;
    expect(rootHasDetector).toBe(false);
    expect(rootHasReconnector).toBe(false);
    expect("HeartbeatDropDetector" in unipls).toBe(false);
    expect("ImmediateReconnector" in unipls).toBe(false);
  });
});
