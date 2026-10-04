/** 低レベルWebSocket clientと、その公開契約を提供します。 */
export {
  UniplsInvalidUsageError,
  UniplsSocketClosedError,
  UniplsSocketDroppedError,
  UniplsSocketError,
  UniplsTimeoutError,
} from "./shared/errors.ts";
export {
  UniplsSocket,
  UniplsWebSocketCloseCode,
  type UniplsSocketCloseMetadata,
  type UniplsSocketDropReport,
  type UniplsSocketEventContext,
  type UniplsSocketInputMetadata,
  type UniplsSocketParams,
  type UniplsSocketPublicEvents,
} from "./socket/unipls-socket.ts";
export type {
  DropDetectorIdentity,
  UniplsConnectionIntent,
  UniplsConnectionState,
  UniplsDropSource,
  WebSocketBlob,
  WebSocketCloseEvent,
  WebSocketConstructor,
  WebSocketData,
  WebSocketErrorEvent,
  WebSocketEventListener,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "./shared/types.ts";
