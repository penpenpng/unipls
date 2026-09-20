import { describe, expect, it } from "vite-plus/test";

import { NetworkDropDetector } from "../../src/browser.ts";
import * as unipls from "../../src/index.ts";

describe("drop detector の公開境界", () => {
  /**
   * ```ts
   * import { HeartbeatDropDetector } from "unipls";
   * import { NetworkDropDetector } from "unipls/browser";
   * // Node.jsなどでrootをimportしてもbrowser固有のwindow依存moduleを読み込まない
   * ```
   */
  it("rootにはheartbeatだけを公開してnetwork detectorをbrowser entryへ分離する", () => {
    // runtime非依存のdetectorはroot、windowを使うdetectorはbrowser entryから取得します。
    expect(unipls.HeartbeatDropDetector).toBeTypeOf("function");
    expect(NetworkDropDetector).toBeTypeOf("function");

    // root declarationにもNetworkDropDetectorが存在しないことを型とruntimeで確認します。
    const rootHasNetworkDetector: "NetworkDropDetector" extends keyof typeof unipls ? true : false =
      false;
    expect(rootHasNetworkDetector).toBe(false);
    expect("NetworkDropDetector" in unipls).toBe(false);
  });
});
