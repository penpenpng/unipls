import { describe, expect, it } from "vite-plus/test";

import * as dropDetectors from "../../src/drop-detectors.ts";
import * as root from "../../src/index.ts";
import * as reconnectors from "../../src/reconnectors.ts";
import * as socket from "../../src/socket.ts";
import type {
  AsyncSubscription,
  ConnectionSetupContext,
  ResourceScope,
  SessionSetupContext,
  StreamBufferOptions,
  StreamFinalization,
  SubscriptionHandle,
  Unipls,
  UniplsCastParams,
  UniplsDropRetryStrategy,
  UniplsEvents,
  UniplsListenCallbackParams,
  UniplsListenIteratorParams,
  UniplsMessageFactory,
  UniplsNextParams,
  UniplsParams,
  UniplsProvisioner,
  UniplsRecoverContext,
  UniplsRecoveryDecision,
  UniplsRecoveryPlan,
  UniplsRecoverStrategy,
  UniplsRequestParams,
  UniplsRetryPreset,
  UniplsRetryStrategy,
  UniplsSubscribeCallbackParams,
  UniplsSubscribeIteratorParams,
  UniplsSubscribeParams,
  WebSocketConstructor,
} from "../../src/index.ts";
import type { ReconnectionContext, UniplsReconnector } from "../../src/reconnectors.ts";
import type { DropDetectorContext, UniplsDropDetector } from "../../src/drop-detectors.ts";
import type {
  UniplsSocketEventContext,
  UniplsSocketParams,
  UniplsSocketPublicEvents,
  WebSocketLike,
} from "../../src/socket.ts";

type PublicContracts = readonly [
  UniplsParams<string, string>,
  UniplsProvisioner<string, string>,
  SessionSetupContext,
  ConnectionSetupContext<string, string>,
  UniplsMessageFactory<string>,
  UniplsCastParams<string>,
  UniplsNextParams<string>,
  UniplsRequestParams<string, string>,
  UniplsListenCallbackParams<string>,
  UniplsListenIteratorParams<string>,
  UniplsSubscribeParams<string, string>,
  UniplsSubscribeCallbackParams<string, string>,
  UniplsSubscribeIteratorParams<string, string>,
  UniplsRetryPreset,
  UniplsDropRetryStrategy,
  UniplsRetryStrategy<string, string>,
  UniplsRecoverContext<string, string>,
  UniplsRecoveryPlan<string, string>,
  UniplsRecoveryDecision<string, string>,
  UniplsRecoverStrategy<string, string>,
  UniplsReconnector,
  ReconnectionContext,
  UniplsDropDetector<string, string>,
  DropDetectorContext<string, string>,
  ResourceScope,
  StreamBufferOptions,
  SubscriptionHandle<StreamFinalization<string>>,
  AsyncSubscription<string>,
  UniplsEvents<string>,
  UniplsSocketParams<string, string>,
  UniplsSocketPublicEvents<string>,
  UniplsSocketEventContext,
  WebSocketLike,
];

const publicContractsCompile: PublicContracts | undefined = undefined;
void publicContractsCompile;

function acceptsPlatformWebSocket(WebSocket: typeof globalThis.WebSocket): WebSocketConstructor {
  return WebSocket;
}
void acceptsPlatformWebSocket;

function narrowFinalization(finalization: StreamFinalization<string>): unknown {
  if (finalization.ok) {
    return finalization.reason === "terminated" ? finalization.message : finalization.reason;
  }
  return finalization.error;
}
void narrowFinalization;

describe("public APIのentry point境界", () => {
  /**
   * ```ts
   * import { Unipls } from "unipls";
   * import { ImmediateReconnector } from "unipls/reconnectors";
   * import { HeartbeatDropDetector, NetworkDropDetector } from "unipls/drop-detectors";
   * import { UniplsSocket } from "unipls/socket";
   * // core、optional extensions、low-level transportを別entry pointで提供する
   * ```
   */
  it("core、extensions、低レベルruntime exportを分離する", () => {
    // package利用者が名前付きimportできるruntime valueをentry pointごとに固定します。
    expect(Object.keys(root).sort()).toEqual([
      "Unipls",
      "UniplsBufferOverflowError",
      "UniplsClosedError",
      "UniplsDroppedError",
      "UniplsError",
      "UniplsInvalidUsageError",
      "UniplsOpenError",
      "UniplsTimeoutError",
    ]);
    expect(Object.keys(socket).sort()).toEqual([
      "UniplsInvalidUsageError",
      "UniplsSocket",
      "UniplsSocketClosedError",
      "UniplsSocketDroppedError",
      "UniplsSocketError",
      "UniplsTimeoutError",
      "UniplsWebSocketCloseCode",
    ]);
    expect(Object.keys(reconnectors).sort()).toEqual([
      "ExponentialBackoffReconnector",
      "ImmediateReconnector",
    ]);
    expect(Object.keys(dropDetectors).sort()).toEqual([
      "HeartbeatDropDetector",
      "NetworkDropDetector",
    ]);
  });

  /**
   * ```ts
   * const client = new Unipls({ url });
   * client.lifecycle; // 高レベル状態の正本
   * client.castForce; // 型エラー
   * client[Symbol.asyncDispose]; // 型エラー
   * // wire-level制御が必要な場合だけunipls/socketを利用する
   * ```
   */
  it("高レベルclientから低レベル状態と暗黙dispose protocolを除外する", () => {
    // 公開classのkeyに互換用APIや低レベルcapabilityが残っていないことを型で確認します。
    type ForbiddenHighLevelKey = Extract<
      "state" | "intent" | "castForce" | "requestForce" | "subscribeForce",
      keyof Unipls
    >;
    const hasForbiddenHighLevelKey: ForbiddenHighLevelKey extends never ? false : true = false;
    const rootHasSocket: "UniplsSocket" extends keyof typeof root ? true : false = false;
    const rootHasSocketError: "UniplsSocketError" extends keyof typeof root ? true : false = false;

    expect(hasForbiddenHighLevelKey).toBe(false);
    expect(rootHasSocket).toBe(false);
    expect(rootHasSocketError).toBe(false);
    expect("UniplsSocket" in root).toBe(false);
    expect("UniplsSocketError" in root).toBe(false);
    expect(Object.getOwnPropertySymbols(root.Unipls.prototype)).toEqual([]);
  });
});
