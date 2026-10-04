import { describe, expect, it } from "vite-plus/test";

import { UniplsInvalidUsageError, type SessionId } from "../../src/index.ts";
import { OwnedResourceScope } from "../../src/shared/resource-scope.ts";

describe("ResourceScope", () => {
  it("disposeをmemoizeして非同期disposerをLIFO順にすべて一度ずつ試行する", async () => {
    // cleanup順と個別の失敗を観測できるsession scopeを作ります。
    const order: string[] = [];
    const failures: Array<{ cause: unknown; name?: string; source: string }> = [];
    const firstCause = new Error("third cleanup failed");
    const secondCause = new Error("second cleanup failed");
    const scope = new OwnedResourceScope({
      scope: Object.freeze({ type: "session", session: "session-test" as SessionId }),
      onCleanupFailure: ({ cause, name, source }) => failures.push({ cause, name, source }),
    });

    scope.defer(
      () => {
        order.push("first");
      },
      { name: "first" },
    );
    scope.defer(async () => {
      order.push("second:start");
      await Promise.resolve();
      order.push("second:end");
      throw secondCause;
    });
    scope.defer(
      () => {
        order.push("third");
        throw firstCause;
      },
      { name: "third" },
    );

    // 最初の呼び出しがsignalを中断し、競合する呼び出しへ同じPromiseを返します。
    const firstDisposal = scope.dispose("done");
    const secondDisposal = scope.dispose("ignored");

    expect(secondDisposal).toBe(firstDisposal);
    expect(scope.signal.aborted).toBe(true);
    expect(order).toEqual(["third", "second:start"]);
    await firstDisposal;

    // cleanup失敗で後続を止めず、登録元と任意nameを個別に記録します。
    expect(order).toEqual(["third", "second:start", "second:end", "first"]);
    expect(failures).toEqual([
      { cause: firstCause, name: "third", source: "defer" },
      { cause: secondCause, name: undefined, source: "defer" },
    ]);
    expect(() => scope.defer(() => {})).toThrow(UniplsInvalidUsageError);
  });

  it("同じscopeのresource name重複を登録時に拒否する", () => {
    // 一意nameを持つresourceを登録します。
    const scope = new OwnedResourceScope({
      scope: Object.freeze({ type: "session", session: "session-test" as SessionId }),
      onCleanupFailure: () => {},
    });

    scope.defer(() => {}, { name: "listener" });

    // 同じnameの2件目はcleanup開始前でも利用者の誤用として拒否します。
    expect(() => scope.defer(() => {}, { name: "listener" })).toThrow(UniplsInvalidUsageError);
    void scope.dispose();
  });
});
