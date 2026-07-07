/**
 * Leak loops. Two independent gauges:
 *  - process RSS (with an explicit GC) for the JS side, and
 *  - the connector's own allocator counters (m2 exports
 *    in-use/mapped bytes) for the native side, which catch a
 *    single leaked K object long before RSS moves.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { dlopen, FFIType as t, suffix } from "bun:ffi";
import { LConnection, lib, vI, vF, I } from "../src/index";
import { PORT, serverUp, ROOT } from "./helpers";

const up = serverUp();

// The allocator statistics entry point lives in the same library the
// client dlopens; it is not part of the l_* surface, so bind it here.
const stats = dlopen(`${ROOT}/build/liblconn.${suffix}`, {
  m2: { args: [], returns: t.ptr },
});

/** [inUse, mapped] bytes currently accounted by the connector. */
function nativeBytes(): [number, number] {
  const k = stats.symbols.m2() as any;
  const v: [number, number] = [
    Number(lib.symbols.l_get_long_at(k, 0)),
    Number(lib.symbols.l_get_long_at(k, 1)),
  ];
  lib.symbols.l_release(k);
  return v;
}

function rss(): number {
  Bun.gc(true);
  return process.memoryUsage().rss;
}

// Native drift tolerance: the atom free-cache holds up to 256
// recycled 16-byte headers and the intern table doubles in rare
// steps; anything above 64KB of steady drift is a real leak.
const NATIVE_SLACK = 65536;

describe.skipIf(!up)("Leak loops", () => {
  let conn: LConnection;
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
    conn.execute(
      "leakT:([]a:til 500;b:500?100.0;s:500#`aa`bb`cc;f:500#1b)",
    );
  });
  afterAll(() => {
    conn.execute("delete leakT from `.");
    conn.close();
  });

  test(
    "1000 mid-size table queries: flat native bytes, bounded RSS",
    () => {
      const query = "select from leakT";
      for (let i = 0; i < 100; i++) conn.execute(query); // warm caches
      const [m0Before] = nativeBytes();
      const rssBefore = rss();
      for (let i = 0; i < 1000; i++) {
        const rows = conn.execute(query) as any[];
        if (i % 250 === 0) expect(rows).toHaveLength(500);
      }
      const [m0After] = nativeBytes();
      const rssAfter = rss();
      expect(Math.abs(m0After - m0Before)).toBeLessThan(NATIVE_SLACK);
      expect(rssAfter - rssBefore).toBeLessThan(96 * 1024 * 1024);
    },
    120000,
  );

  test(
    "1000 error-path iterations leak nothing",
    () => {
      for (let i = 0; i < 50; i++) {
        try { conn.execute("1+`a"); } catch {}
      }
      const [m0Before] = nativeBytes();
      const rssBefore = rss();
      for (let i = 0; i < 1000; i++) {
        try {
          conn.execute("1+`a"); // 'type
          throw new Error("unreachable");
        } catch (e) {
          expect((e as Error).message).toBe("type");
        }
      }
      const [m0After] = nativeBytes();
      expect(Math.abs(m0After - m0Before)).toBeLessThan(NATIVE_SLACK);
      expect(rss() - rssBefore).toBeLessThan(64 * 1024 * 1024);
    },
    120000,
  );

  test(
    "1000 argument-shipping calls leak nothing",
    () => {
      const mk = () => vI(...Array.from({ length: 256 }, (_, i) => i));
      for (let i = 0; i < 50; i++) conn.execute("sum", mk());
      const [m0Before] = nativeBytes();
      for (let i = 0; i < 1000; i++) {
        expect(conn.execute("sum", mk())).toBe(32640);
        if (i % 4 === 0) {
          expect(conn.execute("{x+y}", I(i), I(1))).toBe(i + 1);
        }
      }
      const [m0After] = nativeBytes();
      expect(Math.abs(m0After - m0Before)).toBeLessThan(NATIVE_SLACK);
    },
    120000,
  );

  test(
    "500 set() round trips leak nothing",
    () => {
      for (let i = 0; i < 25; i++) {
        conn.set("leakV", { a: vI(1, 2, 3), b: vF(1.5, 2.5, 3.5) });
      }
      const [m0Before] = nativeBytes();
      for (let i = 0; i < 500; i++) {
        conn.set("leakV", { a: vI(1, 2, 3), b: vF(1.5, 2.5, 3.5) });
      }
      expect(conn.execute("count leakV`a")).toBe(3);
      const [m0After] = nativeBytes();
      expect(Math.abs(m0After - m0Before)).toBeLessThan(NATIVE_SLACK);
      conn.execute("delete leakV from `.");
    },
    120000,
  );

  test("mapped native memory stays bounded across all loops", () => {
    const [, mapped] = nativeBytes();
    // the buddy allocator retains freed blocks on free lists, but
    // total mapped backing must stay sane after thousands of calls
    expect(mapped).toBeLessThan(512 * 1024 * 1024);
  });
});
