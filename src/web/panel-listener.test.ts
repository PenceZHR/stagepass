import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { reservePanelListener } from "./panel-listener";

async function closeServer(server: import("node:http").Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

describe("reserved panel listener", () => {
  it("returns 503 until the reserved server is activated", async () => {
    const reserved = await reservePanelListener({ port: 0 });
    try {
      const port = (reserved.server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;
      const initializing = await fetch(base);

      assert.equal(initializing.status, 503);
      assert.deepEqual(await initializing.json(), {
        code: "stagepass_initializing",
        message: "StagePass is initializing",
      });
      assert.equal(initializing.headers.get("cache-control"), "no-store");

      reserved.activate((_request, response) => response.writeHead(204).end());
      assert.equal((await fetch(base)).status, 204);
      assert.throws(
        () => reserved.activate((_request, response) => response.end()),
        /panel_listener_already_active/,
      );
    } finally {
      await closeServer(reserved.server);
    }
  });

  it("rejects a second reservation for the same loopback port", async () => {
    const first = await reservePanelListener({ port: 0 });
    try {
      const port = (first.server.address() as AddressInfo).port;
      await assert.rejects(
        reservePanelListener({ port }),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "EADDRINUSE",
      );
    } finally {
      await closeServer(first.server);
    }
  });
});
