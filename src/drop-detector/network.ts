import type { DropDetector, DropDetectorContext } from './index.ts';

/**
 * ブラウザの offline イベントを検出して drop とみなす {@link DropDetector} です。
 * ブラウザ環境専用です。
 */
export class NetworkDropDetector implements DropDetector<never, never> {
  setup(ctx: DropDetectorContext<never, never>): () => void {
    const handler = () => ctx.drop();
    window.addEventListener('offline', handler);
    return () => window.removeEventListener('offline', handler);
  }
}
