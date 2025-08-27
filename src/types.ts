/** WebSocket によって送受信することができるデータを表します。 */
export type WebSocketData = string | ArrayBufferLike | Blob | ArrayBufferView;

/**
 * セッションに与えられる一意な識別子です。セッションとは {@link Unipls.connect|unipls.connect()} が呼び出されてから {@link Unipls.close|unipls.close()} が呼び出されるまでの間を指します。
 */
export type SessionId = number;

export type WebSocketConstructor = new (url: string) => WebSocket;

export type UniplsConnectionState =
  | 'connecting'
  | 'open'
  | 'closing'
  | 'closed'
  | 'backoff';
