import { afterEach, expect, test } from "vitest";
import {
  ImmediateReconnector,
  Unipls,
  UniplsClosedError,
  UniplsDroppedError,
  UniplsTimeoutError,
  type WebSocketData,
} from "..";
import { createMockServer } from "./test-utils";

const url = "ws://localhost:8080";
const server = createMockServer(url);
const query = {
  selector: (msg: WebSocketData) => typeof msg === "string" && msg === "msg",
};

afterEach(() => {
  server.reset();
});

test("next() は selector に合致する次のメッセージを取得する", async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const promise = unipls.next(query);

  socket.send("ignored");
  socket.send("msg");

  await expect(promise).resolves.toBe("msg");
});

test("timeout した場合、 UniplsTimeoutError で reject する", async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const promise = unipls.next({
    ...query,
    timeout: 50,
  });

  await expect(promise).rejects.toThrow(UniplsTimeoutError);
});

test("signal が abort されると reject する", async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const controller = new AbortController();
  const promise = unipls.next({
    ...query,
    signal: controller.signal,
  });

  controller.abort(new Error("cancelled"));

  await expect(promise).rejects.toThrow("cancelled");
});

test("close() 時に UniplsClosedError で reject する", async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const promise = unipls.next(query);

  unipls.close();

  await expect(promise).rejects.toThrow(UniplsClosedError);
});

test("reconnector が与えられていない場合、drop 時に UniplsDroppedError で reject する", async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const promise = unipls.next(query);

  unipls.drop();

  await expect(promise).rejects.toThrow(UniplsDroppedError);
});

test("reconnector が与えられていても、retry: fail が指定されている場合は drop 時に UniplsDroppedError で reject する", async () => {
  const reconnector = new ImmediateReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  await server.sockets.dequeue();

  const promise = unipls.next({
    ...query,
    retry: "fail",
  });

  unipls.drop();

  await expect(promise).rejects.toThrow(UniplsDroppedError);
});

test("reconnector が与えられている場合、next() は再接続後もメッセージを待機し続ける", async () => {
  const reconnector = new ImmediateReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  await server.sockets.dequeue();

  const promise = unipls.next({
    ...query,
    retry: "wait",
  });

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  socket2.send("msg");

  await expect(promise).resolves.toBe("msg");
});
