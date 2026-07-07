/**
 * Error CONTENT taxonomy. The original suite only used bare
 * .toThrow(), which passes even when the message is empty — the
 * exact class of regression that let empty error messages ship.
 * Every test here asserts the MESSAGE, not just that a throw
 * happened.
 *
 * Server errors surface as `Error` whose message is exactly the
 * server's error symbol ("type", "length", "rank", "domain", a
 * signalled symbol, or the name of an undefined variable).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { LConnection, I } from "../src/index";
import { PORT, serverUp } from "./helpers";

const up = serverUp();

/** Run fn, assert it throws an Error with exactly this message. */
function expectErr(fn: () => any, message: string) {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(message);
}

describe.skipIf(!up)("Server error taxonomy", () => {
  let conn: LConnection;
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
  });
  afterAll(() => conn.close());

  test("'type carries the symbol", () => {
    expectErr(() => conn.execute("1+`a"), "type");
    expectErr(() => conn.execute('`a=1'), "type");
  });

  test("'length carries the symbol", () => {
    expectErr(() => conn.execute("(1 2)+(1 2 3)"), "length");
    expectErr(() => conn.execute("1 2 3,'1 2"), "length");
  });

  test("'rank carries the symbol", () => {
    expectErr(() => conn.execute("{x+y}[1;2;3]"), "rank");
  });

  test("'domain carries the symbol", () => {
    expectErr(() => conn.execute("1?-5"), "domain");
  });

  test("signalled error carries the signalled symbol", () => {
    expectErr(() => conn.execute("'custom_signal_abc"), "custom_signal_abc");
    expectErr(() => conn.execute('{\'`oops}[]'), "oops");
  });

  test("undefined variable error names the variable", () => {
    expectErr(
      () => conn.execute("some_undefined_variable_xyz"),
      "some_undefined_variable_xyz",
    );
  });

  test("no server error ever arrives with an empty message", () => {
    const provokers = [
      "1+`a",
      "(1 2)+(1 2 3)",
      "{x+y}[1;2;3]",
      "1?-5",
      "'sig",
      "undefined_var_q",
    ];
    for (const q of provokers) {
      let caught: unknown;
      try {
        conn.execute(q);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message.length).toBeGreaterThan(0);
    }
  });

  test("apply with wrong arity reports 'rank", () => {
    // over-application through the args path, not inline text
    expectErr(() => conn.execute("{x}", I(1), I(2)), "rank");
    expectErr(() => conn.execute("{x+y}", I(1), I(2), I(3)), "rank");
  });

  test("apply with wrong argument type reports 'type", () => {
    expectErr(() => conn.execute("{x+`a}", I(1)), "type");
  });

  test("applying a non-function: 'domain or index identity", () => {
    // atom application is indexing in q — newer servers answer
    // 3[42] = 3, older ones signal 'domain. Either is legitimate;
    // what must never happen is a mangled or empty error.
    let result: any;
    let caught: unknown;
    try {
      result = conn.execute("3", I(42));
    } catch (e) {
      caught = e;
    }
    if (caught) {
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("domain");
    } else {
      expect(result).toBe(3);
    }
  });

  test("connection stays usable across alternating errors", () => {
    for (let i = 0; i < 20; i++) {
      expectErr(() => conn.execute("1+`a"), "type");
      expect(conn.execute(`${i}+${i}`)).toBe(2 * i);
      expectErr(() => conn.execute("{x+y}[1;2;3]"), "rank");
      expect(conn.execute("2+2")).toBe(4);
    }
  });

  test("error message is the bare server symbol (no wrapping)", () => {
    try {
      conn.execute("1+`a");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("Error");
      expect((e as Error).message).not.toContain(":");
      expect((e as Error).message).toBe("type");
    }
  });
});

describe.skipIf(!up)("Connection lifecycle errors", () => {
  test("query after close throws cleanly, repeatedly", () => {
    const c = LConnection.connect("localhost", PORT);
    expect(c.execute("1+1")).toBe(2);
    c.close();
    for (let i = 0; i < 10; i++) {
      expectErr(() => c.execute("1+1"), "Connection is closed");
    }
  });

  test("set after close throws cleanly", () => {
    const c = LConnection.connect("localhost", PORT);
    c.close();
    expectErr(() => c.set("x", 42), "Connection is closed");
  });

  test("double close is idempotent", () => {
    const c = LConnection.connect("localhost", PORT);
    expect(c.isConnected).toBe(true);
    c.close();
    expect(c.isConnected).toBe(false);
    c.close(); // second close must be a no-op, not a double-close
    c.close();
    expect(c.isConnected).toBe(false);
  });

  test("a closed connection does not affect a live one", () => {
    const a = LConnection.connect("localhost", PORT);
    const b = LConnection.connect("localhost", PORT);
    a.close();
    a.close();
    expect(b.execute("6*7")).toBe(42); // b's fd must be untouched
    b.close();
  });

  test("connect to a dead port fails fast and clean", () => {
    const t0 = Date.now();
    let caught: unknown;
    try {
      LConnection.connect("localhost", 49321);
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - t0;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Failed to connect");
    expect(elapsed).toBeLessThan(1000); // refused, not a hung retry
  });

  test("handshake refusal (peer closes without ACK) throws", async () => {
    // A fake peer that accepts the TCP connection, reads the
    // credentials, then closes without sending the 1-byte ACK. The
    // connector returns handle 0 for this; treating 0 as success
    // would point every later query at file descriptor 0. The peer
    // must live in a subprocess: the sync connect blocks this
    // thread's event loop.
    const peerPort = PORT + 1111;
    const peer = Bun.spawn(
      [
        process.execPath,
        "-e",
        `Bun.listen({ hostname: "127.0.0.1", port: ${peerPort},
          socket: { open() {}, data(s) { s.end(); } } });
        console.log("ready");`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    try {
      const reader = (peer.stdout as ReadableStream).getReader();
      await reader.read(); // wait for "ready"
      let caught: unknown;
      try {
        LConnection.connect("localhost", peerPort);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Failed to connect");
    } finally {
      peer.kill();
      await peer.exited;
    }
  }, 15000);
});
