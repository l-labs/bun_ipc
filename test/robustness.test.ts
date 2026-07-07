/**
 * Server-death robustness. Every test here spawns its own
 * sacrificial L server (env L_BIN — the `l` executable) so it can
 * kill it freely; the shared test server is only used to prove the
 * client process is still healthy afterwards. Skips when L_BIN is
 * unset.
 */
import { describe, test, expect } from "bun:test";
import { LConnection, I, vI } from "../src/index";
import { PORT, serverUp, spawnServer, killServer, L_BIN } from "./helpers";

const up = serverUp();
const gated = up && !!L_BIN;

describe.skipIf(!gated)("Server death", () => {
  test(
    "calls after a server kill fail fast and clean, never hang",
    async () => {
      const port = PORT + 1201;
      const proc = await spawnServer(port);
      const c = LConnection.connect("localhost", port);
      expect(c.execute("1+1")).toBe(2); // live connection, then...
      await killServer(proc);

      for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        let caught: unknown;
        try {
          c.execute("2+2");
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message.length).toBeGreaterThan(0);
        expect(Date.now() - t0).toBeLessThan(2000); // fail, not hang
      }
      c.close(); // close of a dead connection must be quiet
      expect(c.isConnected).toBe(false);
    },
    30000,
  );

  test(
    "argument-shipping calls also fail cleanly on a dead server",
    async () => {
      const port = PORT + 1202;
      const proc = await spawnServer(port);
      const c = LConnection.connect("localhost", port);
      expect(c.execute("sum", vI(1, 2, 3))).toBe(6);
      await killServer(proc);
      expect(() => c.execute("sum", vI(1, 2, 3))).toThrow();
      expect(() => c.set("x", { a: [1, 2, 3] })).toThrow();
      c.close();
    },
    30000,
  );

  test(
    "a dead server does not poison other connections",
    async () => {
      const port = PORT + 1203;
      const proc = await spawnServer(port);
      const doomed = LConnection.connect("localhost", port);
      const healthy = LConnection.connect("localhost", PORT);
      expect(doomed.execute("1+1")).toBe(2);
      await killServer(proc);
      expect(() => doomed.execute("1+1")).toThrow();
      // the shared-server connection must be completely unaffected
      expect(healthy.execute("6*7")).toBe(42);
      doomed.close();
      healthy.close();
    },
    30000,
  );

  test(
    "reconnecting to a restarted server on the same port works",
    async () => {
      const port = PORT + 1204;
      let proc = await spawnServer(port);
      const first = LConnection.connect("localhost", port);
      expect(first.execute("1+1")).toBe(2);
      await killServer(proc);
      expect(() => first.execute("1+1")).toThrow(); // old handle dead
      first.close();

      proc = await spawnServer(port); // same port, new process
      try {
        const second = LConnection.connect("localhost", port);
        expect(second.execute("2+3")).toBe(5);
        second.close();
      } finally {
        await killServer(proc);
      }
    },
    30000,
  );

  test(
    "client survives a server that dies evaluating its query",
    async () => {
      // Applying an unresolvable name — ("no_such_fn"; arg) — takes
      // the current L server down mid-query (server-side bug: the
      // string form of the same error is answered gracefully). The
      // client contract under test: whether the server answers or
      // dies, the call throws a clean Error and this process keeps
      // going with its heap intact.
      const port = PORT + 1205;
      const proc = await spawnServer(port);
      const c = LConnection.connect("localhost", port);
      let caught: unknown;
      try {
        c.execute("definitely_not_defined_fn", I(1));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message.length).toBeGreaterThan(0);
      expect(() => c.execute("1+1")).toThrow(); // connection is gone
      c.close();
      await killServer(proc); // reap whatever is left

      // client process heap still coherent
      const healthy = LConnection.connect("localhost", PORT);
      expect(healthy.execute("{(x;y)}", I(7), I(9))).toEqual([7, 9]);
      healthy.close();
    },
    30000,
  );
});
