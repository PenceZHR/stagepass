import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { BindingStore } from "../store/binding-store";
import { createPanelServer } from "./panel-server";
import type { PtySession } from "./pty-session";

/**
 * The panel over a real socket, with a fake pty in place of Codex.
 *
 * What is proved here is the half with no Codex in it: eleven phases offered,
 * bytes reaching the browser unchanged, keystrokes reaching the pty, and a
 * phase never getting a second live process.
 *
 * ## Why every test tears its own server down
 *
 * The output endpoint never ends its response -- that is what a terminal is.
 * So a server left listening, or a stream left open, keeps the test process
 * alive forever, and `after()` hooks are too late because they run once the
 * whole file is done. Each test owns its server and closes it, connections
 * included.
 */

const CHANGE = "CHG-PANEL";

interface Fake {
  started: { changeId: string; phase: string; threadId: string | null }[];
  written: Uint8Array[];
  resized: { cols: number; rows: number }[];
  emit(bytes: Uint8Array): void;
}

async function withPanel(
  body: (context: {
    base: string;
    pty: Fake;
    database: Database.Database;
    open: (path: string, init?: RequestInit) => Promise<Response>;
  }) => Promise<void>,
): Promise<void> {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ChangeStore(database).create(CHANGE);

  const started: Fake["started"] = [];
  const written: Uint8Array[] = [];
  const resized: Fake["resized"] = [];
  const emitters: ((bytes: Uint8Array) => void)[] = [];
  const pty: Fake = {
    started, written, resized,
    emit: (bytes) => { for (const listener of emitters) listener(bytes); },
  };

  const start = ((input: {
    changeId: string; phase: string; threadId: string | null;
  }): PtySession => {
    started.push({ ...input });
    let alive = true;
    return {
      changeId: input.changeId,
      phase: input.phase as PtySession["phase"],
      onBytes(listener) { emitters.push(listener); },
      onExit() { /* the fake never exits */ },
      write(bytes) { written.push(bytes); },
      resize(cols, rows) { resized.push({ cols, rows }); },
      kill() { alive = false; },
      get alive() { return alive; },
    };
  }) as never;

  const { server } = createPanelServer({
    database, session: { cwd: "/tmp" }, start,
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Streams opened by a test, cancelled before teardown so nothing is left
  // holding a socket.
  const streams: Response[] = [];
  const open = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await fetch(`${base}${path}`, init);
    streams.push(response);
    return response;
  };

  try {
    await body({ base, pty, database, open });
  } finally {
    for (const response of streams) {
      try { await response.body?.cancel(); } catch { /* already done */ }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    database.close();
  }
}

describe("panel · what it offers", () => {
  it("offers eleven phases, and never Done", async () => {
    await withPanel(async ({ open }) => {
      const panel = await (await open(`/api/panel?change=${CHANGE}`)).json() as {
        phases: { phase: string; threadId: string | null; live: boolean }[];
      };
      assert.equal(panel.phases.length, 11);
      assert.ok(!panel.phases.some((entry) => entry.phase === "Done"));
      assert.deepEqual(panel.phases[0], { phase: "PRD", threadId: null, live: false });
    });
  });

  it("shows the thread a phase is bound to", async () => {
    await withPanel(async ({ open, database }) => {
      new BindingStore(database).bind(CHANGE, "Spec", "THREAD-SPEC");
      const panel = await (await open(`/api/panel?change=${CHANGE}`)).json() as {
        phases: { phase: string; threadId: string | null }[];
      };
      assert.equal(
        panel.phases.find((entry) => entry.phase === "Spec")?.threadId,
        "THREAD-SPEC",
      );
    });
  });

  it("serves the page, and refuses a phase that has no terminal", async () => {
    await withPanel(async ({ open }) => {
      const page = await open("/");
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /text\/html/);
      await page.text();

      assert.equal((await open(`/pty/${CHANGE}/Nonsense`)).status, 404);
      // Done is a real phase and still has no terminal: nothing runs there.
      assert.equal((await open(`/pty/${CHANGE}/Done`)).status, 404);
    });
  });
});

describe("panel · bytes go through untouched", () => {
  it("forwards what the pty produced, byte for byte", async () => {
    await withPanel(async ({ open, pty }) => {
      const response = await open(`/pty/${CHANGE}/PRD`);
      const reader = response.body!.getReader();

      // An escape sequence plus a multi-byte character -- exactly what a
      // decode-then-forward implementation corrupts at a chunk boundary.
      const sent = new Uint8Array([
        0x1b, 0x5b, 0x33, 0x31, 0x6d,
        0xe8, 0xaf, 0xb7, 0xe8, 0xa3, 0x81, 0xe5, 0x86, 0xb3,
      ]);
      pty.emit(sent);

      const { value } = await reader.read();
      assert.deepEqual(Array.from(value!), Array.from(sent));
      reader.releaseLock();
    });
  });

  it("sends keystrokes to the pty as bytes", async () => {
    await withPanel(async ({ open, pty }) => {
      // Down arrow, then Enter: the two keys a gate decision needs.
      const keys = new Uint8Array([0x1b, 0x5b, 0x42, 0x0d]);
      const posted = await open(`/pty/${CHANGE}/PRD/in`, { method: "POST", body: keys });
      assert.equal(posted.status, 204);
      assert.deepEqual(Array.from(pty.written[0]!), Array.from(keys));
    });
  });

  it("passes the browser's size through to the pty", async () => {
    await withPanel(async ({ open, pty }) => {
      await open(`/pty/${CHANGE}/PRD/resize?cols=100&rows=40`, { method: "POST" });
      assert.deepEqual(pty.resized.at(-1), { cols: 100, rows: 40 });
    });
  });
});

describe("panel · one live process per phase thread", () => {
  it("does not start a second process for a phase that has one", async () => {
    await withPanel(async ({ open, pty }) => {
      await open(`/pty/${CHANGE}/PRD`);
      await open(`/pty/${CHANGE}/PRD`);
      await open(`/pty/${CHANGE}/PRD/in`, {
        method: "POST", body: new Uint8Array([0x0d]),
      });
      assert.equal(pty.started.length, 1);
    });
  });

  it("gives a different phase its own process", async () => {
    await withPanel(async ({ open, pty }) => {
      await open(`/pty/${CHANGE}/PRD`);
      await open(`/pty/${CHANGE}/Spec`);
      assert.equal(pty.started.length, 2);
      assert.deepEqual(pty.started.map((entry) => entry.phase), ["PRD", "Spec"]);
    });
  });

  it("resumes the phase's bound thread rather than starting a new one", async () => {
    await withPanel(async ({ open, pty, database }) => {
      new BindingStore(database).bind(CHANGE, "Spec", "THREAD-SPEC");
      await open(`/pty/${CHANGE}/PRD`);
      await open(`/pty/${CHANGE}/Spec`);
      assert.equal(pty.started.find((e) => e.phase === "PRD")?.threadId, null);
      assert.equal(pty.started.find((e) => e.phase === "Spec")?.threadId, "THREAD-SPEC");
    });
  });
});
