import { afterEach, expect, test } from "vitest";
import { UniplsSocket } from "..";
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
