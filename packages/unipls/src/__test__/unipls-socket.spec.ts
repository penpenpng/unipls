import { afterEach, expect, test } from "vitest";
import { UniplsSocket, UniplsSocketClosedError, UniplsSocketDroppedError } from "..";
import { createMockServer } from "./test-utils";

const url = "ws://localhost:8080";
const server = createMockServer(url);

afterEach(() => {
  server.reset();
});

test("open() と close() に応じて state が遷移する", async () => {
  const socket = new UniplsSocket({ url });

  const openPromise = socket.open();
  expect(socket.state).toBe("connecting");

  await server.sockets.dequeue();
  await openPromise;
  expect(socket.state).toBe("open");

  await socket.close();
  expect(socket.state).toBe("closed");
});

test("接続されていない状態の enqueue() は UniplsSocketClosedError で reject する", async () => {
  const socket = new UniplsSocket({ url });

  await expect(socket.enqueue("ping")).rejects.toThrow(UniplsSocketClosedError);
});

test("接続処理中に drop された open() は UniplsSocketDroppedError で reject する", async () => {
  const provisioning = Promise.withResolvers<void>();
  const socket = new UniplsSocket({ url });

  const promise = socket.open(() => provisioning.promise);
  await server.sockets.dequeue();

  socket.drop();

  await expect(promise).rejects.toThrow(UniplsSocketDroppedError);
});
