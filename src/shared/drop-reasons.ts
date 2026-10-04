import type { UniplsDrop } from "./types.ts";

/** 組み込み detector が報告する安定した理由です。 */
export const DropReasons = Object.freeze({
  BROWSER_LIFECYCLE_PROBE_TIMEOUT: "browser-lifecycle/probe-timeout",
  HEARTBEAT_RESPONSE_TIMEOUT: "heartbeat/response-timeout",
} as const);

/** browser lifecycle を契機にした probe の timeout か判定します。 */
export function isBrowserLifecycleDrop(drop: UniplsDrop | undefined): boolean {
  return (
    drop?.source.type === "detector" &&
    drop.source.reason === DropReasons.BROWSER_LIFECYCLE_PROBE_TIMEOUT
  );
}
