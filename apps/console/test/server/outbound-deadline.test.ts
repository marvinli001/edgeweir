import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import type { AppContext } from "../../src/server/lib/context";
import { postNotification, withinDeadline } from "../../src/server/lib/outbound";

it("settles pending work when its deadline is cancelled", async () => {
  const controller = new AbortController();
  const operation = withinDeadline(new Promise<string>(() => {}), controller.signal);
  const checked = expect(operation).rejects.toThrow("deadline");
  controller.abort(new Error("deadline"));
  await checked;
});

it("cancels the HTTP response at the total deadline and still accepts a normal response", async () => {
  let pendingStarted!: () => void;
  const pendingRequest = new Promise<void>((resolve) => {
    pendingStarted = resolve;
  });
  const server = http.createServer((request, response) => {
    if (request.url === "/ready") {
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(200);
    response.flushHeaders();
    pendingStarted();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app = { env: { EDGEWEIR_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" } } as AppContext;
  const controller = new AbortController();
  const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  try {
    await expect(postNotification(app, `${target}/ready`, {})).resolves.toEqual({ ok: true });
    const cancelled = expect(postNotification(app, `${target}/pending`, {})).rejects.toThrow();
    await pendingRequest;
    controller.abort(new Error("deadline"));
    await cancelled;
    expect(deadline).toHaveBeenCalledWith(10000);
    expect(controller.signal.aborted).toBe(true);
  } finally {
    deadline.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
