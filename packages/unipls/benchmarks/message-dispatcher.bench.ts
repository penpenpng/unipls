import { afterAll, bench, describe } from "vite-plus/test";

import { MessageDispatcher } from "../src/operations/message-dispatcher.ts";
import type { SessionId } from "../src/types.ts";

interface ResponseMessage {
  readonly requestId: number;
  readonly topic: string;
}

const session = "benchmark-session" as SessionId;
const message: ResponseMessage = Object.freeze({ requestId: -1, topic: "unmatched" });

describe("selector broadcast の fan-out", () => {
  for (const activeOperations of [1, 10, 100, 1_000, 10_000]) {
    const dispatcher = new MessageDispatcher<ResponseMessage>();
    let selectorCalls = 0;
    let matches = 0;

    // request ID待機とtopic購読を半数ずつ登録し、全operationがactiveな不一致messageを測定します。
    for (let correlationKey = 0; correlationKey < activeOperations; correlationKey += 1) {
      const operationType = correlationKey % 2 === 0 ? "request" : "subscribe";
      const topic = `topic-${correlationKey}`;
      dispatcher.register({
        session,
        operationType,
        mode: { type: "ready" },
        receive(received) {
          selectorCalls += 1;
          const matched =
            operationType === "request"
              ? received.requestId === correlationKey
              : received.topic === topic;
          if (matched) matches += 1;
        },
      });
    }

    bench(
      `${activeOperations.toLocaleString("en-US")} active operations`,
      () => {
        dispatcher.dispatchReady(session, message);
      },
      { time: 1_000, warmupTime: 250 },
    );

    // benchmarkが想定した不一致selectorを実際に評価したことを確認します。
    afterAll(() => {
      if (selectorCalls === 0) throw new Error("selectorが呼び出されませんでした。");
      if (matches !== 0) throw new Error("不一致messageがselectorと一致しました。");
    });
  }
});
