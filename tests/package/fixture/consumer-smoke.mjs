function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Promiseがrejectしませんでした。");
}

class TestWebSocket {
  static instances = [];

  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  sent = [];
  closeRequests = [];

  constructor(url) {
    this.url = url;
    TestWebSocket.instances.push(this);
  }

  send(data) {
    if (this.readyState !== 1) throw new Error("WebSocketがopenではありません。");
    this.sent.push(data);
  }

  close(code, reason) {
    this.readyState = 2;
    this.closeRequests.push({ code, reason });
  }

  emitOpen() {
    this.readyState = 1;
    this.onopen?.({ type: "open" });
  }

  emitMessage(data) {
    this.onmessage?.({ data });
  }

  emitClose({ code = 1000, reason = "", wasClean = code === 1000 } = {}) {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean });
  }
}

function currentSocket() {
  const socket = TestWebSocket.instances.at(-1);
  if (!socket) throw new Error("WebSocketが作成されていません。");
  return socket;
}

function replaceGlobalValue(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.configurable) {
    if (!("value" in descriptor) || !descriptor.writable) return false;
    globalThis[name] = value;
    return true;
  }
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  return true;
}

function replaceGlobalGetter(name, get) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.configurable) return false;
  Object.defineProperty(globalThis, name, { get, configurable: true });
  return true;
}

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}

function handlersAreDetached(socket) {
  return (
    socket.onopen === null &&
    socket.onmessage === null &&
    socket.onerror === null &&
    socket.onclose === null
  );
}

export async function runConsumerSmoke({ browser = false } = {}) {
  const previousWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

  try {
    // ! module評価時にglobal WebSocketを要求せず、非browserではwindowにも触れません。
    const guardedWebSocket = replaceGlobalGetter("WebSocket", () => {
      throw new Error("module importがglobal WebSocketへアクセスしました。");
    });
    const guardedWindow =
      !browser &&
      replaceGlobalGetter("window", () => {
        throw new Error("root importがwindowへアクセスしました。");
      });
    const root = await import("unipls");
    const socketEntry = await import("unipls/socket");
    const dropDetectorEntry = await import("unipls/drop-detectors");
    if (guardedWindow) restoreGlobal("window", previousWindow);
    assert(!("NetworkDropDetector" in root), "rootにbrowser固有exportが含まれています。");
    assert(
      typeof dropDetectorEntry.NetworkDropDetector === "function",
      "Node.jsでdrop-detectors entryをimportできませんでした。",
    );

    // globalも注入もない構成だけを同期的な利用誤りとして拒否します。
    if (guardedWebSocket) replaceGlobalValue("WebSocket", undefined);
    let configurationError;
    try {
      new root.Unipls({
        url: "wss://unipls.test/socket",
        ...(guardedWebSocket ? {} : { WebSocket: null }),
      });
    } catch (error) {
      configurationError = error;
    }
    assert(
      configurationError instanceof root.UniplsInvalidUsageError,
      "global WebSocket欠落時の構成errorが不正です。",
    );

    // ! 注入constructorは利用可能なglobalより常に優先されます。
    class UnexpectedGlobalWebSocket {
      constructor() {
        throw new Error("注入constructorよりglobalが優先されました。");
      }
    }
    replaceGlobalValue("WebSocket", UnexpectedGlobalWebSocket);
    TestWebSocket.instances.length = 0;
    const client = new root.Unipls({
      url: "wss://unipls.test/socket",
      WebSocket: TestWebSocket,
    });
    const opening = client.open();
    const connection = currentSocket();
    connection.emitOpen();
    await opening;

    // user、operation scope、timeoutの合成後も最初のabort reasonを同じ参照で返します。
    const controller = new AbortController();
    const reason = { type: "consumer-abort" };
    const response = client.next({
      selector: () => false,
      signal: controller.signal,
      timeout: 10_000,
    });
    controller.abort(reason);
    assert(
      (await rejectionOf(response)) === reason,
      "operationがabort reasonの参照を保持しませんでした。",
    );

    // ready接続でapplication messageを受信し、明示close後に全handlerを解放します。
    const messages = client.listen({});
    const next = messages[Symbol.asyncIterator]().next();
    connection.emitMessage("message");
    const result = await next;
    assert(
      !result.done && result.value === "message",
      "高レベルclientがmessageを配送しませんでした。",
    );
    const closing = client.close();
    connection.emitClose();
    await closing;
    const closed = await messages.closed;
    assert(closed.ok && closed.reason === "closed", "session closeの終了結果が不正です。");
    assert(handlersAreDetached(connection), "session close後にtransport handlerが残っています。");

    // ! peer dropはsessionとstreamをterminal outcomeへ進め、transport handlerを解放します。
    const droppedClient = new root.Unipls({
      url: "wss://unipls.test/drop",
      WebSocket: TestWebSocket,
    });
    const droppedOpening = droppedClient.open();
    const droppedConnection = currentSocket();
    droppedConnection.emitOpen();
    await droppedOpening;
    const droppedMessages = droppedClient.listen({ retry: "wait" });
    droppedConnection.emitClose({ code: 4100, wasClean: false });
    const dropped = await droppedMessages.closed;
    assert(!dropped.ok && dropped.reason === "dropped", "dropの終了結果が不正です。");
    assert(droppedClient.lifecycle.phase === "closed", "drop後にsessionが終了していません。");
    assert(handlersAreDetached(droppedConnection), "drop後にtransport handlerが残っています。");
    await droppedClient.close();

    // ! constructor option省略時は構築時点のglobal WebSocketを使用します。
    replaceGlobalValue("WebSocket", TestWebSocket);
    const globalClient = new root.Unipls({ url: "wss://unipls.test/global" });
    const globalOpening = globalClient.open();
    const globalConnection = currentSocket();
    globalConnection.emitOpen();
    await globalOpening;
    const globalClosing = globalClient.close();
    globalConnection.emitClose();
    await globalClosing;
    assert(
      handlersAreDetached(globalConnection),
      "global WebSocketを使う高レベルclientが接続を解放しませんでした。",
    );

    const lowLevel = new socketEntry.UniplsSocket({ url: "wss://unipls.test/low-level" });
    const lowOpening = lowLevel.open();
    const lowConnection = currentSocket();
    lowConnection.emitOpen();
    await lowOpening;
    await lowLevel.enqueue("ping");
    assert(lowConnection.sent[0] === "ping", "低レベルclientがdataを送信しませんでした。");
    const lowClosing = lowLevel.close();
    lowConnection.emitClose();
    await lowClosing;
    assert(lowLevel.state === "closed", "低レベルclientがcloseへ遷移しませんでした。");
    assert(
      handlersAreDetached(lowConnection),
      "低レベルclose後にtransport handlerが残っています。",
    );

    // ! 低レベルclientもpeer closeをdropへ分類し、接続固有handlerを解放します。
    const droppedLowLevel = new socketEntry.UniplsSocket({
      url: "wss://unipls.test/low-level-drop",
      WebSocket: TestWebSocket,
    });
    const droppedLowOpening = droppedLowLevel.open();
    const droppedLowConnection = currentSocket();
    droppedLowConnection.emitOpen();
    await droppedLowOpening;
    droppedLowConnection.emitClose({ code: 4101, wasClean: false });
    assert(droppedLowLevel.state === "dropped", "低レベルclientがdropへ遷移しませんでした。");
    assert(
      handlersAreDetached(droppedLowConnection),
      "低レベルdrop後にtransport handlerが残っています。",
    );
    await droppedLowLevel.close();

    // native AbortSignal.anyは入力済みsignalの先頭reasonと最初の後発reasonを保持します。
    const first = new AbortController();
    const second = new AbortController();
    const firstReason = { source: "first" };
    const secondReason = { source: "second" };
    first.abort(firstReason);
    second.abort(secondReason);
    assert(
      AbortSignal.any([first.signal, second.signal]).reason === firstReason,
      "AbortSignal.anyが先頭の入力済みreasonを保持しませんでした。",
    );
    const laterFirst = new AbortController();
    const laterSecond = new AbortController();
    const combined = AbortSignal.any([laterFirst.signal, laterSecond.signal]);
    laterFirst.abort(firstReason);
    assert(
      combined.reason === firstReason,
      "AbortSignal.anyが最初の後発reasonを保持しませんでした。",
    );
    laterSecond.abort(secondReason);
    assert(combined.reason === firstReason, "AbortSignal.anyが後続abortでreasonを変更しました。");

    return { checks: 16 };
  } finally {
    restoreGlobal("WebSocket", previousWebSocket);
    if (!browser) restoreGlobal("window", previousWindow);
  }
}
