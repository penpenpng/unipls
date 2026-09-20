import type { UniplsReconnector, UniplsReconnectorActions } from "./reconnector";

/** drop を検出すると待機せずに1回の再接続を開始します。 */
export class ImmediateReconnector implements UniplsReconnector {
  /** 再接続操作をただちに実行します。 */
  setup({ reconnect }: UniplsReconnectorActions) {
    reconnect();
  }
}
