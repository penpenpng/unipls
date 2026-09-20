// Non-normative historical reference. See README.md; do not treat as a contract test.
import { expect, test, vi } from "vitest";
import { EventBus } from "../../../src/event-bus.ts";

interface TestEvents {
  event: string;
}

test("on() は once オプションが指定された listener を一度だけ呼び出す", () => {
  const events = new EventBus<TestEvents>();
  const listener = vi.fn();

  events.on("event", listener, { once: true });
  events.emit("event", "first");
  events.emit("event", "second");

  expect(listener).toHaveBeenCalledOnce();
  expect(listener).toHaveBeenCalledWith("first");
});

test("off() は on() に渡した listener を解除する", () => {
  const events = new EventBus<TestEvents>();
  const listener = vi.fn();

  events.on("event", listener);
  events.off("event", listener);
  events.emit("event", "ignored");

  expect(listener).not.toHaveBeenCalled();
});
