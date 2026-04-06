import type { DropDetectorContext, UniplsDropDetector } from "./index.ts";

/**
 * ブラウザの offline イベントを検出して drop とみなす {@link UniplsDropDetector} です。
 * ブラウザ環境専用です。
 */
export class NetworkDropDetector implements UniplsDropDetector<never, never> {
  setup(ctx: DropDetectorContext<never, never>): () => void {
    const handler = () => ctx.drop();
    window.addEventListener("offline", handler);
    return () => window.removeEventListener("offline", handler);
  }
}
