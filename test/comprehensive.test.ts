/**
 * Comprehensive IPC tests for the Bun/FFI L interface.
 *
 * Covers all L types, tables, keyed tables, dictionaries,
 * QSQL operations, string operations, null/infinity values,
 * sorting, shape operations, and large data.
 *
 * Start the server:  l -p 5001
 * Run:               L_TEST_PORT=5001 bun test
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  LConnection,
  I, J, E, F, G, H, C, S, B, D, T, Z,
  vI, vJ, vE, vF, vG, vH, vC, vS, vD, vT, vZ,
} from "../src/index";

const PORT = parseInt(process.env.L_TEST_PORT || "5001");

let serverAvailable = false;
try {
  const c = LConnection.connect("localhost", PORT);
  c.close();
  serverAvailable = true;
} catch {
  console.log(`L server not on port ${PORT}, comprehensive tests skipped`);
}

describe.skipIf(!serverAvailable)("Comprehensive L Tests", () => {
  let conn: LConnection;

  beforeAll(() => { conn = LConnection.connect("localhost", PORT); });
  afterAll(() => { conn?.close(); });

  // ═══════════════════════════════════════════════════════════════
  // ATOMS — every scalar type returned by the server
  // ═══════════════════════════════════════════════════════════════

  describe("Atoms", () => {
    test("bool true/false", () => {
      expect(conn.execute("1b")).toBe(true);
      expect(conn.execute("0b")).toBe(false);
    });

    test("byte", () => {
      expect(conn.execute("0x42")).toBe(0x42);
    });

    test("short", () => {
      expect(conn.execute("42h")).toBe(42);
    });

    test("int", () => {
      expect(conn.execute("42")).toBe(42);
      expect(conn.execute("-99")).toBe(-99);
    });

    test("long", () => {
      const v = conn.execute("42j");
      // Long atoms may come back as number or bigint depending on magnitude
      expect(Number(v)).toBe(42);
    });

    test("long large", () => {
      const v = conn.execute("1000000000000j");
      expect(Number(v)).toBe(1000000000000);
    });

    test("real (f32)", () => {
      const v = conn.execute("3.14e");
      expect(v).toBeCloseTo(3.14, 1);
    });

    test("float (f64)", () => {
      expect(conn.execute("3.14")).toBeCloseTo(3.14, 5);
    });

    test("char", () => {
      // Single char may come back as string or char code
      const v = conn.execute('"x"');
      expect(String(v)).toContain("x");
    });

    test("symbol", () => {
      expect(conn.execute("`IBM")).toBe("IBM");
      expect(conn.execute("`")).toBe("");
    });

    test("string (char vector)", () => {
      expect(String(conn.execute('"hello world"'))).toBe("hello world");
    });

    test("date", () => {
      // 2000.01.01 = 0 days from epoch
      const v = conn.execute("2000.01.01");
      // May be raw int (0) or Date object
      if (v instanceof Date) {
        expect(v.getUTCFullYear()).toBe(2000);
      } else {
        expect(v).toBe(0);
      }
    });

    test("time", () => {
      // 12:00:00.000 = 43200000 ms
      const v = conn.execute("12:00:00.000");
      if (v instanceof Date) {
        expect(v.getTime()).toBe(43200000);
      } else {
        expect(v).toBe(43200000);
      }
    });

    test("datetime", () => {
      const v = conn.execute("2000.01.01T12:00:00.000");
      expect(v).toBeDefined();
    });

    test("month", () => {
      const v = conn.execute("2000.01m");
      expect(v).toBeDefined();
    });

    test("minute", () => {
      const v = conn.execute("12:30");
      expect(v).toBeDefined();
    });

    test("second", () => {
      const v = conn.execute("12:30:45");
      expect(v).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // TEMPORAL — L has no timezone concept, all values are raw
  //   date:     int32, days from 2000.01.01
  //   time:     int32, milliseconds from midnight
  //   datetime: float64, fractional days from 2000.01.01
  //   month:    int32, months from 2000.01
  //   minute:   int32, minutes from midnight
  //   second:   int32, seconds from midnight
  // ═══════════════════════════════════════════════════════════════

  describe("Temporal", () => {
    test("date epoch (2000.01.01 = 0)", () => {
      const v = conn.execute("2000.01.01");
      // Raw value is 0 days from epoch
      if (v instanceof Date) {
        expect(v.getUTCFullYear()).toBe(2000);
        expect(v.getUTCMonth()).toBe(0);
        expect(v.getUTCDate()).toBe(1);
      } else {
        expect(v).toBe(0);
      }
    });

    test("date offset (2000.01.11 = 10)", () => {
      const v = conn.execute("2000.01.11");
      if (v instanceof Date) {
        expect(v.getUTCDate()).toBe(11);
      } else {
        expect(v).toBe(10);
      }
    });

    test("date arithmetic", () => {
      // Adding int to date produces date
      const v = conn.execute("2000.01.01 + 10");
      if (v instanceof Date) {
        expect(v.getUTCDate()).toBe(11);
      } else {
        expect(v).toBe(10);
      }
    });

    test("date difference", () => {
      expect(conn.execute("2000.01.11 - 2000.01.01")).toBe(10);
    });

    test("time (12:00:00.000 = 43200000ms)", () => {
      const v = conn.execute("12:00:00.000");
      if (v instanceof Date) {
        expect(v.getTime()).toBe(43200000);
      } else {
        expect(v).toBe(43200000);
      }
    });

    test("datetime (fractional days)", () => {
      // 2000.01.01T12:00:00.000 = 0.5 days from epoch
      const v = conn.execute("2000.01.01T12:00:00.000");
      if (v instanceof Date) {
        expect(v.getUTCFullYear()).toBe(2000);
        expect(v.getUTCHours()).toBe(12);
      } else if (typeof v === "number") {
        expect(v).toBeCloseTo(0.5, 3);
      }
    });

    test("datetime vector", () => {
      const v = conn.execute(
        "2000.01.01T00:00:00.000 2000.01.01T12:00:00.000",
      ) as Date[];
      expect(v).toHaveLength(2);
      expect(v[0]).toBeInstanceOf(Date);
      expect(v[0].getUTCFullYear()).toBe(2000);
    });

    test("date vector", () => {
      const v = conn.execute("2000.01.01 2000.01.02 2000.01.03") as any[];
      expect(v).toHaveLength(3);
      // Date vectors come back as JS Date objects
      expect(v[0]).toBeInstanceOf(Date);
    });

    test("time vector", () => {
      const v = conn.execute("00:00:00.000 12:00:00.000") as number[];
      expect(v).toHaveLength(2);
      // Time vectors are raw milliseconds (no timezone)
      expect(v[0]).toBe(0);
      expect(v[1]).toBe(43200000);
    });

    test("month (2000.01m = 0)", () => {
      const v = conn.execute("2000.01m");
      // Raw months from 2000.01
      if (typeof v === "number") expect(v).toBe(0);
    });

    test("minute (12:30 = 750)", () => {
      const v = conn.execute("12:30");
      if (typeof v === "number") expect(v).toBe(750);
    });

    test("second (12:30:45 = 45045)", () => {
      const v = conn.execute("12:30:45");
      if (typeof v === "number") expect(v).toBe(45045);
    });

    test("send date generator", () => {
      // D(0) = 2000.01.01, add 1 = 2000.01.02
      const v = conn.execute("{x+1}", D(0));
      if (v instanceof Date) {
        expect(v.getUTCDate()).toBe(2);
      } else {
        expect(v).toBe(1);
      }
    });

    test("send time generator", () => {
      const v = conn.execute("{x}", T(43200000));
      if (v instanceof Date) {
        expect(v.getTime()).toBe(43200000);
      } else {
        expect(v).toBe(43200000);
      }
    });

    test("send datetime generator", () => {
      const dt = new Date("2024-06-15T10:30:00Z");
      const v = conn.execute("::", Z(dt));
      // Should round-trip as a Date
      expect(v).toBeInstanceOf(Date);
      // Verify year/month/day survive (no timezone shift)
      expect(v.getUTCFullYear()).toBe(2024);
      expect(v.getUTCMonth()).toBe(5);                                          // June = 5
      expect(v.getUTCDate()).toBe(15);
    });

    test("table with temporal columns", () => {
      conn.execute("tt:([]dt:2000.01.01 2000.01.02 + 0 0;price:100.0 200.0)");
      const t = conn.execute("select from tt") as any[];
      expect(t).toHaveLength(2);
      expect(t[0]).toHaveProperty("dt");
      expect(t[0]).toHaveProperty("price");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // NULL & INFINITY
  // ═══════════════════════════════════════════════════════════════

  describe("Null & Infinity", () => {
    test("null int", () => {
      // 0N = -2147483648 (0x80000000)
      expect(conn.execute("0N")).toBe(-2147483648);
    });

    test("infinity int", () => {
      expect(conn.execute("0W")).toBe(2147483647);
    });

    test("null float", () => {
      expect(conn.execute("0n")).toBeNaN();
    });

    test("infinity float", () => {
      const v = conn.execute("0w") as number;
      expect(v).toBe(Infinity);
    });

    test("negative infinity float", () => {
      const v = conn.execute("-0w") as number;
      expect(v).toBe(-Infinity);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // VECTORS — typed arrays
  // ═══════════════════════════════════════════════════════════════

  describe("Vectors", () => {
    test("int vector", () => {
      expect(conn.execute("1 2 3 4 5")).toEqual([1, 2, 3, 4, 5]);
    });

    test("float vector", () => {
      const v = conn.execute("1.1 2.2 3.3") as number[];
      expect(v).toHaveLength(3);
      expect(v[0]).toBeCloseTo(1.1, 1);
    });

    test("bool vector", () => {
      expect(conn.execute("10101b")).toEqual([true, false, true, false, true]);
    });

    test("symbol vector", () => {
      expect(conn.execute("`IBM`MSFT`AAPL")).toEqual(["IBM", "MSFT", "AAPL"]);
    });

    test("short vector", () => {
      expect(conn.execute("1 2 3h")).toEqual([1, 2, 3]);
    });

    test("byte vector", () => {
      expect(conn.execute("0x010203")).toEqual([1, 2, 3]);
    });

    test("long vector", () => {
      const v = conn.execute("1 2 3j");
      expect(v).toHaveLength(3);
    });

    test("date vector", () => {
      const v = conn.execute("2000.01.01 2000.01.02 2000.01.03") as any[];
      expect(v).toHaveLength(3);
      // Date vectors come back as JS Date objects
      expect(v[0]).toBeInstanceOf(Date);
    });

    test("time vector", () => {
      const v = conn.execute("00:00:00.000 12:00:00.000") as number[];
      expect(v).toHaveLength(2);
      // Time vectors are raw milliseconds (no timezone)
      expect(v[0]).toBe(0);
      expect(v[1]).toBe(43200000);
    });

    test("empty vector", () => {
      const v = conn.execute("`int$()");
      expect(v).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ARITHMETIC
  // ═══════════════════════════════════════════════════════════════

  describe("Arithmetic", () => {
    test("basic ops", () => {
      expect(conn.execute("1+1")).toBe(2);
      expect(conn.execute("10-3")).toBe(7);
      expect(conn.execute("3*4")).toBe(12);
      expect(conn.execute("10 mod 3")).toBe(1);
    });

    test("divide returns float", () => {
      expect(conn.execute("10%3")).toBeCloseTo(3.333, 2);
    });

    test("aggregations", () => {
      expect(conn.execute("sum 1 2 3 4 5")).toBe(15);
      expect(conn.execute("prd 1 2 3 4 5")).toBe(120);
      expect(conn.execute("min 5 3 8 1 9")).toBe(1);
      expect(conn.execute("max 5 3 8 1 9")).toBe(9);
      expect(conn.execute("avg 1 2 3 4 5")).toBeCloseTo(3.0, 2);
    });

    test("math functions", () => {
      expect(conn.execute("sqrt 2")).toBeCloseTo(1.41421, 3);
      expect(conn.execute("abs -42")).toBe(42);
    });

    test("running aggregations", () => {
      expect(conn.execute("sums 1 2 3 4 5")).toEqual([1, 3, 6, 10, 15]);
      expect(conn.execute("maxs 3 1 4 1 5")).toEqual([3, 3, 4, 4, 5]);
      expect(conn.execute("mins 3 1 4 1 5")).toEqual([3, 1, 1, 1, 1]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // STRING OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  describe("String Operations", () => {
    test("join", () => {
      expect(String(conn.execute('"hello","world"'))).toBe("helloworld");
    });

    test("count", () => {
      expect(conn.execute('count "hello"')).toBe(5);
    });

    test("reverse", () => {
      expect(String(conn.execute('reverse "abc"'))).toBe("cba");
    });

    test("upper/lower", () => {
      // the server returns char vectors; coerce to a primitive
      // string for comparison
      const upper = conn.execute('upper "hello"');
      expect(String(upper)).toBe("HELLO");
      const lower = conn.execute('lower "HELLO"');
      expect(String(lower)).toBe("hello");
    });

    test("like pattern match", () => {
      expect(conn.execute('"hello" like "hel*"')).toBe(true);
      expect(conn.execute('"hello" like "xyz*"')).toBe(false);
    });

    test("trim", () => {
      const trimmed = conn.execute('trim "  hello  "');
      expect(String(trimmed)).toBe("hello");
    });

    test("ssr (search-replace)", () => {
      const replaced = conn.execute('ssr["hello world";"world";"there"]');
      expect(String(replaced)).toBe("hello there");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SHAPE & SEARCH OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  describe("Shape & Search", () => {
    test("til", () => {
      expect(conn.execute("til 5")).toEqual([0, 1, 2, 3, 4]);
    });

    test("reverse", () => {
      expect(conn.execute("reverse 1 2 3")).toEqual([3, 2, 1]);
    });

    test("take", () => {
      expect(conn.execute("3#1 2 3 4 5")).toEqual([1, 2, 3]);
    });

    test("take overextend (cyclic)", () => {
      expect(conn.execute("5#1 2 3")).toEqual([1, 2, 3, 1, 2]);
    });

    test("drop", () => {
      expect(conn.execute("2_1 2 3 4 5")).toEqual([3, 4, 5]);
    });

    test("rotate", () => {
      expect(conn.execute("2 rotate 1 2 3 4 5")).toEqual([3, 4, 5, 1, 2]);
    });

    test("where", () => {
      expect(conn.execute("where 10101b")).toEqual([0, 2, 4]);
    });

    test("distinct", () => {
      expect(conn.execute("distinct 1 2 2 3 3 3")).toEqual([1, 2, 3]);
    });

    test("asc/desc", () => {
      expect(conn.execute("asc 3 1 4 1 5")).toEqual([1, 1, 3, 4, 5]);
      expect(conn.execute("desc 3 1 4 1 5")).toEqual([5, 4, 3, 1, 1]);
    });

    test("enlist", () => {
      expect(conn.execute("enlist 42")).toEqual([42]);
    });

    test("raze", () => {
      expect(conn.execute("raze (1 2;3 4;5 6)")).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test("count", () => {
      expect(conn.execute("count 1 2 3 4 5")).toBe(5);
    });

    test("type", () => {
      expect(conn.execute("type 42")).toBe(-6);
    });

    test("find", () => {
      expect(conn.execute("1 2 3 4 5?3")).toBe(2);
    });

    test("in (membership)", () => {
      expect(conn.execute("3 in 1 2 3 4 5")).toBe(true);
      expect(conn.execute("99 in 1 2 3 4 5")).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DICTIONARIES
  // ═══════════════════════════════════════════════════════════════

  describe("Dictionaries", () => {
    test("simple int-valued dict", () => {
      const d = conn.execute("`a`b`c!1 2 3");
      expect(d).toEqual({ a: 1, b: 2, c: 3 });
    });

    test("float-valued dict", () => {
      const d = conn.execute("`x`y!3.14 2.72") as Record<string, number>;
      expect(d.x).toBeCloseTo(3.14, 2);
      expect(d.y).toBeCloseTo(2.72, 2);
    });

    test("symbol-valued dict", () => {
      const d = conn.execute("`a`b!`IBM`MSFT");
      expect(d).toEqual({ a: "IBM", b: "MSFT" });
    });

    test("mixed-valued dict", () => {
      conn.execute("md:`name`age`active!(`Alice;30;1b)");
      const d = conn.execute("md") as Record<string, any>;
      expect(d.name).toBe("Alice");
      expect(d.age).toBe(30);
      expect(d.active).toBe(true);
    });

    test("dict count", () => {
      expect(conn.execute("count `a`b`c!1 2 3")).toBe(3);
    });

    test("dict key/value", () => {
      expect(conn.execute("key `a`b!1 2")).toEqual(["a", "b"]);
      expect(conn.execute("value `a`b!1 2")).toEqual([1, 2]);
    });

    test("dict indexing", () => {
      conn.execute("dd:`a`b`c!10 20 30");
      expect(conn.execute("dd[`b]")).toBe(20);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SIMPLE TABLES
  // ═══════════════════════════════════════════════════════════════

  describe("Tables", () => {
    test("create and read simple table", () => {
      const t = conn.execute("([]a:1 2 3;b:`x`y`z)") as any[];
      expect(Array.isArray(t)).toBe(true);
      expect(t).toHaveLength(3);
      expect(t[0].a).toBe(1);
      expect(t[0].b).toBe("x");
      expect(t[2].a).toBe(3);
      expect(t[2].b).toBe("z");
    });

    test("table with float column", () => {
      const t = conn.execute("([]sym:`IBM`MSFT;price:120.5 340.2)") as any[];
      expect(t).toHaveLength(2);
      expect(t[0].sym).toBe("IBM");
      expect(t[0].price).toBeCloseTo(120.5, 1);
      expect(t[1].sym).toBe("MSFT");
      expect(t[1].price).toBeCloseTo(340.2, 1);
    });

    test("empty table", () => {
      const t = conn.execute("([]a:`int$();b:`float$())") as any[];
      expect(Array.isArray(t)).toBe(true);
      expect(t).toHaveLength(0);
    });

    test("table count", () => {
      conn.execute("ct1:([]a:1 2 3;b:10 20 30)");
      expect(conn.execute("count ct1")).toBe(3);
    });

    test("table cols", () => {
      conn.execute("ct2:([]sym:`A`B;price:1.0 2.0)");
      expect(conn.execute("cols ct2")).toEqual(["sym", "price"]);
    });

    test("table column access", () => {
      conn.execute("ct3:([]a:1 2 3;b:10 20 30)");
      expect(conn.execute("ct3`a")).toEqual([1, 2, 3]);
    });

    test("select with where", () => {
      conn.execute("ct4:([]sym:`IBM`MSFT`AAPL;price:120.5 340.2 175.8)");
      const r = conn.execute("select from ct4 where price>200") as any[];
      expect(r).toHaveLength(1);
      expect(r[0].sym).toBe("MSFT");
    });

    test("select specific columns", () => {
      conn.execute("ct5:([]a:1 2 3;b:10 20 30;c:`x`y`z)");
      const r = conn.execute("select a,c from ct5") as any[];
      expect(r[0]).toHaveProperty("a");
      expect(r[0]).toHaveProperty("c");
      expect(r[0]).not.toHaveProperty("b");
    });

    test("table insert", () => {
      conn.execute("ct6:([]a:1 2;b:10 20)");
      conn.execute("`ct6 insert (3;30)");
      expect(conn.execute("count ct6")).toBe(3);
    });

    test("table update", () => {
      conn.execute("ct7:([]a:1 2 3;b:10 20 30)");
      conn.execute("update b:b*2 from `ct7");
      expect(conn.execute("ct7`b")).toEqual([20, 40, 60]);
    });

    test("table delete rows", () => {
      conn.execute("ct8:([]a:1 2 3;b:10 20 30)");
      conn.execute("delete from `ct8 where a=2");
      expect(conn.execute("count ct8")).toBe(2);
    });

    test("table with bool column", () => {
      const t = conn.execute(
        "([]name:`Alice`Bob`Charlie;active:110b)",
      ) as any[];
      expect(t[0].active).toBe(true);
      expect(t[1].active).toBe(true);
      expect(t[2].active).toBe(false);
    });

    test("multi-type table", () => {
      conn.execute(
        "mt:([]sym:`IBM`MSFT;price:120.5 340.2;qty:100 200;active:10b)",
      );
      const t = conn.execute("select from mt") as any[];
      expect(t).toHaveLength(2);
      expect(t[0].sym).toBe("IBM");
      expect(t[0].price).toBeCloseTo(120.5, 1);
      expect(t[0].qty).toBe(100);
      expect(t[0].active).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // KEYED TABLES
  // ═══════════════════════════════════════════════════════════════

  describe("Keyed Tables", () => {
    test("single-key table", () => {
      const r = conn.execute("([id:1 2 3] name:`Alice`Bob`Charlie)");
      expect(r).toBeDefined();
      // Keyed table should have column arrays
      expect(r.id).toEqual([1, 2, 3]);
      expect(r.name).toEqual(["Alice", "Bob", "Charlie"]);
    });

    test("select avg by (produces keyed table)", () => {
      const r = conn.execute(
        "select avg price by sym from " +
          "([]sym:`IBM`MSFT`IBM;price:120.5 340.2 121.0)"
      );
      expect(r).toBeDefined();
      expect(r.sym).toBeDefined();
      expect(r.price).toBeDefined();
      expect(r.sym).toContain("IBM");
      expect(r.sym).toContain("MSFT");
    });

    test("select sum by multiple keys", () => {
      conn.execute(
        "kt1:([]sym:`A`A`B`B;side:`buy`sell`buy`sell;qty:100 200 150 300)",
      );
      const r = conn.execute("select sum qty by sym,side from kt1");
      expect(r.sym).toBeDefined();
      expect(r.side).toBeDefined();
      expect(r.qty).toBeDefined();
    });

    test("keyed table count", () => {
      conn.execute("kt2:([id:1 2 3] name:`A`B`C)");
      expect(conn.execute("count kt2")).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // JOINS
  // ═══════════════════════════════════════════════════════════════

  describe("Joins", () => {
    test("inner join (ij)", () => {
      conn.execute("jt1:([id:1 2 3] name:`A`B`C)");
      conn.execute("jt2:([id:1 2 3] val:10 20 30)");
      const r = conn.execute("jt1 ij jt2");
      expect(r).toBeDefined();
      expect(r.name).toBeDefined();
      expect(r.val).toBeDefined();
    });

    test("left join (lj)", () => {
      conn.execute("ljt1:([id:1 2 3 4] name:`A`B`C`D)");
      conn.execute("ljt2:([id:1 2] val:10 20)");
      const r = conn.execute("ljt1 lj ljt2");
      expect(r).toBeDefined();
      expect(r.name).toHaveLength(4);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // MIXED LISTS
  // ═══════════════════════════════════════════════════════════════

  describe("Mixed Lists", () => {
    test("heterogeneous list", () => {
      const r = conn.execute("(1;2.0;`abc)") as any[];
      expect(r).toHaveLength(3);
      expect(r[0]).toBe(1);
      expect(r[1]).toBeCloseTo(2.0, 1);
      expect(r[2]).toBe("abc");
    });

    test("nested int vectors", () => {
      const r = conn.execute("(1 2 3;4 5 6)") as any[];
      expect(r).toHaveLength(2);
      expect(r[0]).toEqual([1, 2, 3]);
      expect(r[1]).toEqual([4, 5, 6]);
    });

    test("mixed with string", () => {
      const r = conn.execute('(42;"hello";`sym)') as any[];
      expect(r).toHaveLength(3);
      expect(r[0]).toBe(42);
      expect(String(r[1])).toBe("hello");
      expect(r[2]).toBe("sym");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // FUNCTIONAL FORMS
  // ═══════════════════════════════════════════════════════════════

  describe("Functional", () => {
    test("lambda", () => {
      expect(conn.execute("{x+y}[3;4]")).toBe(7);
    });

    test("each", () => {
      expect(conn.execute("{x*x} each 1 2 3 4 5")).toEqual([1, 4, 9, 16, 25]);
    });

    test("over (fold)", () => {
      expect(conn.execute("{x+y} over 1 2 3 4 5")).toBe(15);
    });

    test("scan (running fold)", () => {
      expect(conn.execute("{x+y} scan 1 2 3 4 5")).toEqual([1, 3, 6, 10, 15]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CASTING
  // ═══════════════════════════════════════════════════════════════

  describe("Casting", () => {
    test("int to float", () => {
      expect(conn.execute("`float$42")).toBeCloseTo(42.0, 1);
    });

    test("string to symbol", () => {
      expect(conn.execute('`$"hello"')).toBe("hello");
    });

    test("string function", () => {
      expect(String(conn.execute("string 42"))).toBe("42");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // STATISTICS
  // ═══════════════════════════════════════════════════════════════

  describe("Statistics", () => {
    test("med", () => {
      expect(conn.execute("med 1 2 3 4 5")).toBeCloseTo(3.0, 1);
    });

    test("dev", () => {
      const v = conn.execute("dev 1 2 3 4 5") as number;
      expect(v).toBeGreaterThan(1.0);
      expect(v).toBeLessThan(2.0);
    });

    test("var", () => {
      expect(conn.execute("var 1 2 3 4 5")).toBeCloseTo(2.0, 0);
    });

    test("cor (perfect)", () => {
      expect(conn.execute("1 2 3 4 5 cor 1 2 3 4 5")).toBeCloseTo(1.0, 3);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SEND K OBJECTS (generators)
  // ═══════════════════════════════════════════════════════════════

  describe("Send K Objects", () => {
    test("send int", () => {
      expect(conn.execute("{x+1}", I(41))).toBe(42);
    });

    test("send float", () => {
      expect(conn.execute("{x*2.0}", F(3.14))).toBeCloseTo(6.28, 1);
    });

    test("send symbol", () => {
      conn.execute("st:([]sym:`IBM`MSFT;price:120.5 340.2)");
      const r = conn.execute("{select from st where sym=x}", S("IBM")) as any[];
      expect(r).toHaveLength(1);
      expect(r[0].sym).toBe("IBM");
    });

    test("send int vector", () => {
      expect(conn.execute("sum", vI(1, 2, 3, 4, 5))).toBe(15);
    });

    test("send float vector", () => {
      expect(conn.execute("avg", vF(1.0, 2.0, 3.0))).toBeCloseTo(2.0, 1);
    });

    test("send two args", () => {
      expect(conn.execute("{x+y}", I(10), I(32))).toBe(42);
    });

    test("send three args", () => {
      expect(conn.execute("{x+y+z}", I(10), I(20), I(12))).toBe(42);
    });

    test("send table via set + flip", () => {
      conn.set("st2", {
        a: vI(1, 2, 3),
        b: vF(10.0, 20.0, 30.0),
      });
      conn.execute("st2: flip st2");
      expect(conn.execute("count st2")).toBe(3);
      const t = conn.execute("select from st2") as any[];
      expect(t[0].a).toBe(1);
      expect(t[0].b).toBeCloseTo(10.0, 1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // LARGE DATA
  // ═══════════════════════════════════════════════════════════════

  describe("Large Data", () => {
    test("large vector from query", () => {
      const v = conn.execute("til 10000") as number[];
      expect(v).toHaveLength(10000);
      expect(v[0]).toBe(0);
      expect(v[9999]).toBe(9999);
    });

    test("large sum", () => {
      expect(conn.execute("sum til 10000")).toBe(49995000);
    });

    test("send large vector via generator", () => {
      const vals = Array.from({ length: 1000 }, (_, i) => i);
      expect(conn.execute("sum", vI(...vals))).toBe(499500);
    });

    test("large table query", () => {
      conn.execute(
        "lt:([]sym:1000?`IBM`MSFT`AAPL;price:1000?100.0;qty:1000?1000)",
      );
      const t = conn.execute("select from lt") as any[];
      expect(t).toHaveLength(1000);
      expect(t[0]).toHaveProperty("sym");
      expect(t[0]).toHaveProperty("price");
      expect(t[0]).toHaveProperty("qty");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ERROR HANDLING
  // ═══════════════════════════════════════════════════════════════

  describe("Error Handling", () => {
    test("type error", () => {
      expect(() => conn.execute("1+`abc")).toThrow();
    });

    test("undefined variable", () => {
      expect(() => conn.execute("undefined_var_xyz")).toThrow();
    });

    test("rank error", () => {
      expect(() => conn.execute("{x+y}[1;2;3]")).toThrow();
    });

    test("recovers after error", () => {
      expect(() => conn.execute("bad_query_xyz")).toThrow();
      expect(conn.execute("1+1")).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CONNECTION LIFECYCLE
  // ═══════════════════════════════════════════════════════════════

  describe("Connection", () => {
    test("isConnected property", () => {
      const c2 = LConnection.connect("localhost", PORT);
      expect(c2.isConnected).toBe(true);
      c2.close();
      expect(c2.isConnected).toBe(false);
    });

    test("execute after close throws", () => {
      const c2 = LConnection.connect("localhost", PORT);
      c2.close();
      expect(() => c2.execute("1+1")).toThrow("Connection is closed");
    });

    test("connect to bad port throws", () => {
      expect(() => LConnection.connect("localhost", 19999)).toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // GENERATOR SEMANTICS
  // ═══════════════════════════════════════════════════════════════

  describe("Generator Semantics", () => {
    test("generators are zero-arg functions", () => {
      const gen = I(42);
      expect(typeof gen).toBe("function");
      expect(gen.length).toBe(0);
    });

    test("generators can be reused", () => {
      const gen = I(100);
      expect(conn.execute("::", gen)).toBe(100);
      expect(conn.execute("::", gen)).toBe(100);
      expect(conn.execute("::", gen)).toBe(100);
    });

    test("vector generator reuse in loop", () => {
      const gen = vI(1, 2, 3, 4, 5);
      for (let i = 0; i < 10; i++) {
        expect(conn.execute("count", gen)).toBe(5);
      }
    });

    test("nested table via set + flip", () => {
      conn.set("genTable", {
        ints: vI(1, 2, 3, 4, 5),
        floats: vF(1.1, 2.2, 3.3, 4.4, 5.5),
        symbols: vS("a", "b", "c", "d", "e"),
      });
      conn.execute("genTable: flip genTable");
      expect(conn.execute("count genTable")).toBe(5);
      const t = conn.execute("select from genTable") as any[];
      expect(t[0].ints).toBe(1);
      expect(t[0].symbols).toBe("a");
    });
  });
});
