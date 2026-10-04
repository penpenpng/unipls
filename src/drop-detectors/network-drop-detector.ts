import type { DropDetectorContext, UniplsDropDetector } from "./drop-detector.ts";

/**
 * ブラウザの offline イベントを検出して drop とみなす {@link UniplsDropDetector} です。
 * ブラウザ環境専用です。
 */
export class NetworkDropDetector implements UniplsDropDetector<never, never> {
  /** 現在の接続に対する `offline` イベントの監視を開始します。 */
  setup(ctx: DropDetectorContext<never, never>): void {
    const handler = ctx.guard(() => ctx.drop());

    window.addEventListener("offline", handler);
    ctx.defer(() => window.removeEventListener("offline", handler), { name: "offline-listener" });
  }
}
