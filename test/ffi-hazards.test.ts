/**
 * FFI hazard tests. Anything that could take down the whole process
 * with a native fault runs in a subprocess (runSub): a segfault
 * there is a failed assertion here, not a dead test runner. That is
 * exactly how the non-symbol-dict crash and the function-result
 * crash were caught.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync } from "fs";
import { LConnection, I, F, vI } from "../src/index";
import { PORT, serverUp, runSub, L_BIN } from "./helpers";

const up = serverUp();

describe.skipIf(!up)("Crash-prone conversions (subprocess)", () => {
  test("non-symbol dict keys convert without a native fault", () => {
    // regression: `1 2!3 4` used to walk the int key vector with the
    // object getter, reinterpreting ints as pointers -> SIGSEGV
    const r = runSub(`
      const c = LConnection.connect("localhost", PORT);
      console.log(JSON.stringify(c.execute("1 2!3 4")));
      console.log(JSON.stringify(c.execute("1.5 2.5!\`a\`b")));
      c.close();`);
    expect(r.signalCode).toBeNull();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[[1,3],[2,4]]");
  });

  test("char-vector dict values convert without a native fault", () => {
    const r = runSub(`
      const c = LConnection.connect("localhost", PORT);
      console.log(JSON.stringify(c.execute('\`a\`b!"xy"')));
      c.close();`);
    expect(r.signalCode).toBeNull();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('{"a":"x","b":"y"}');
  });

  test("function-valued results do not walk garbage lengths", () => {
    // primitives arrive as atoms whose length field is meaningless;
    // converting them as lists used to read out of bounds
    const r = runSub(`
      const c = LConnection.connect("localhost", PORT);
      console.log(JSON.stringify(c.execute("+")));       // primitive
      console.log(JSON.stringify(c.execute("first")));   // primitive
      console.log(JSON.stringify(c.execute("{x+y}[1]"))); // projection
      console.log(JSON.stringify(c.execute("{x+1}")));   // lambda
      console.log("alive", c.execute("1+1"));
      c.close();`);
    expect(r.signalCode).toBeNull();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("alive 2");
  });
});

describe.skipIf(!up)("Use-after-close", () => {
  test("wrapper-level: closed connection refuses work forever", () => {
    const c = LConnection.connect("localhost", PORT);
    c.close();
    for (let i = 0; i < 50; i++) {
      expect(() => c.execute("1+1")).toThrow("Connection is closed");
      expect(() => c.set("x", i)).toThrow("Connection is closed");
    }
  });

  test("raw FFI: queries on a closed fd fail without a fault", () => {
    // bypass the wrapper guard entirely and hammer the closed
    // descriptor at the C level; must yield null results, not
    // crashes (subprocess: no other sockets may recycle the fd)
    const r = runSub(`
      const c = LConnection.connect("localhost", PORT);
      const handle = (c as any).handle;
      c.close();
      let nulls = 0;
      for (let i = 0; i < 20; i++) {
        const res = lib.symbols.l_k(handle, Buffer.from("1+1\\0"));
        if (!res) nulls++;
        else lib.symbols.l_release(res);
      }
      console.log("nulls", nulls);`);
    expect(r.signalCode).toBeNull();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nulls 20");
  });
});

describe.skipIf(!up)("Connection churn", () => {
  test(
    "500 rapid connect/close cycles do not exhaust fds",
    () => {
      const fdDir = "/dev/fd"; // works on macOS and Linux
      const before = readdirSync(fdDir).length;
      for (let i = 0; i < 500; i++) {
        const c = LConnection.connect("localhost", PORT);
        if (i % 100 === 0) expect(c.execute("1+1")).toBe(2);
        c.close();
      }
      const after = readdirSync(fdDir).length;
      expect(after - before).toBeLessThanOrEqual(4); // no fd creep
    },
    60000,
  );

  test("3 interleaved connections stay independent", () => {
    const conns = [0, 1, 2].map(() =>
      LConnection.connect("localhost", PORT),
    );
    // round-robin: each connection carries its own arithmetic
    for (let round = 0; round < 20; round++) {
      for (let k = 0; k < 3; k++) {
        expect(conns[k].execute(`${round}+${k}`)).toBe(round + k);
      }
    }
    // closing one must not disturb the others
    conns[1].close();
    expect(conns[0].execute("100+1")).toBe(101);
    expect(conns[2].execute("100+3")).toBe(103);
    expect(() => conns[1].execute("1")).toThrow("Connection is closed");
    conns[0].close();
    expect(conns[2].execute("7*6")).toBe(42);
    conns[2].close();
  });
});

describe.skipIf(!up)("Double-free provocation", () => {
  test("one generator used twice in a single call is safe", () => {
    const c = LConnection.connect("localhost", PORT);
    const g = I(21);
    // each use runs the generator afresh: two distinct K objects,
    // both consumed by the call — nothing is freed twice
    expect(c.execute("{x+y}", g, g)).toBe(42);
    const vg = vI(1, 2, 3);
    expect(c.execute("{x,y}", vg, vg)).toEqual([1, 2, 3, 1, 2, 3]);
    c.close();
  });

  test("generator reuse across 100 calls never aliases atoms", () => {
    const c = LConnection.connect("localhost", PORT);
    const g7 = I(7);
    const gf = F(2.25);
    for (let i = 0; i < 100; i++) {
      // if any object were freed twice, the allocator's free list
      // would hand the same block to both args and the pair would
      // come back aliased/corrupt
      expect(c.execute("{(x;y)}", g7, gf)).toEqual([7, 2.25]);
    }
    c.close();
  });

  test.skipIf(!L_BIN)(
    "set() failure path never releases a consumed argument",
    async () => {
      // regression: set() used to release its K argument again after
      // l_execute1 had already consumed it. The block entered the
      // free list twice, later allocations aliased, and the client
      // heap corrupted. Run against a sacrificial server (the query
      // that provokes the failure can take the server down — a
      // separate, server-side bug), then prove this process's
      // allocator is still coherent against the main server.
      const { spawnServer, killServer } = await import("./helpers");
      const sacPort = PORT + 1210;
      const sac = await spawnServer(sacPort);
      try {
        const r = runSub(`
          const sc = LConnection.connect("localhost", ${sacPort});
          for (let i = 0; i < 50; i++) {
            try { sc.set("bad name!!", 42); } catch (e) {}
          }
          // allocator canary: fresh atoms must not alias
          const mc = LConnection.connect("localhost", PORT);
          for (let i = 0; i < 50; i++) {
            const pair = mc.execute("{(x;y)}", I(7), F(2.25));
            if (pair[0] !== 7 || pair[1] !== 2.25) {
              throw new Error("aliased atoms: " + JSON.stringify(pair));
            }
          }
          console.log("canary clean");
          mc.close();`);
        expect(r.signalCode).toBeNull();
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("canary clean");
      } finally {
        await killServer(sac);
      }
    },
    30000,
  );
});
