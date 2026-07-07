/**
 * Full type-matrix depth: exact round-trip values for every
 * constructible atom and vector type, the null sentinel of every
 * type, IEEE edge values, the 64-bit number/bigint policy at the
 * 2^53 boundary, unicode, and empty/single-element vectors.
 *
 * The mappings asserted here are the documented contract (README
 * "Type mapping" and "Null sentinels" tables).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  LConnection,
  B, G, H, I, J, E, F, C, S, D, T, Z,
  vG, vH, vI, vJ, vE, vF, vS, vD, vT, vZ, vC,
} from "../src/index";
import { PORT, serverUp } from "./helpers";

const up = serverUp();

describe.skipIf(!up)("Atom exact round trips", () => {
  let conn: LConnection;
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
  });
  afterAll(() => conn.close());

  test("boolean", () => {
    expect(conn.execute("1b")).toBe(true);
    expect(conn.execute("0b")).toBe(false);
    expect(conn.execute("::", B(true))).toBe(true);
    expect(conn.execute("::", B(false))).toBe(false);
  });

  test("byte full range", () => {
    expect(conn.execute("0x00")).toBe(0);
    expect(conn.execute("0xff")).toBe(255);
    expect(conn.execute("0x7f")).toBe(127);
    expect(conn.execute("::", G(200))).toBe(200);
  });

  test("short boundaries", () => {
    expect(conn.execute("32766h")).toBe(32766);
    expect(conn.execute("-32766h")).toBe(-32766);
    expect(conn.execute("::", H(-12345))).toBe(-12345);
  });

  test("int boundaries", () => {
    expect(conn.execute("2147483646")).toBe(2147483646);
    expect(conn.execute("-2147483646")).toBe(-2147483646);
    expect(conn.execute("::", I(-2000000000))).toBe(-2000000000);
  });

  test("long within safe range is a number", () => {
    const v = conn.execute("1234567890123j");
    expect(typeof v).toBe("number");
    expect(v).toBe(1234567890123);
    expect(conn.execute("::", J(-987654321098))).toBe(-987654321098);
  });

  test("real (f32) round trips at f32 precision", () => {
    expect(conn.execute("1.5e")).toBe(1.5); // exact in f32
    expect(conn.execute("::", E(-2.25))).toBe(-2.25);
    expect(conn.execute("3.14e")).toBeCloseTo(3.14, 5);
  });

  test("float (f64) is exact", () => {
    expect(conn.execute("3.141592653589793")).toBe(3.141592653589793);
    expect(conn.execute("::", F(1e-9))).toBe(1e-9);
    expect(conn.execute("::", F(1.7976931348623157e308)))
      .toBe(1.7976931348623157e308);
  });

  test("char", () => {
    expect(conn.execute('"x"')).toBe("x");
    expect(conn.execute("::", C("q"))).toBe("q");
  });

  test("symbol", () => {
    expect(conn.execute("`IBM")).toBe("IBM");
    expect(conn.execute("::", S("hello_world"))).toBe("hello_world");
  });

  test("date atom is a JS Date (UTC midnight)", () => {
    const v = conn.execute("2000.01.11") as Date;
    expect(v).toBeInstanceOf(Date);
    expect(v.toISOString()).toBe("2000-01-11T00:00:00.000Z");
    const rt = conn.execute("::", D(new Date(Date.UTC(2024, 5, 15)))) as Date;
    expect(rt.toISOString()).toBe("2024-06-15T00:00:00.000Z");
  });

  test("datetime atom is a JS Date", () => {
    const v = conn.execute("2000.01.01T12:00:00.000") as Date;
    expect(v).toBeInstanceOf(Date);
    expect(v.getTime()).toBe(Date.UTC(2000, 0, 1, 12));
  });

  test("time/month/minute/second atoms are raw counts", () => {
    expect(conn.execute("12:00:00.000")).toBe(43200000); // ms
    expect(conn.execute("2001.03m")).toBe(14);           // months
    expect(conn.execute("12:30")).toBe(750);             // minutes
    expect(conn.execute("12:30:45")).toBe(45045);        // seconds
    expect(conn.execute("::", T(43200000))).toBe(43200000);
  });

  test("timestamp atom: raw ns, number in safe range", () => {
    expect(conn.execute("2000.01.01D00:00:00.000000001")).toBe(1);
    // a real-world timestamp exceeds 2^53 ns and must be bigint
    const big = conn.execute("2000.05.01D0");
    expect(typeof big).toBe("bigint");
    expect(big).toBe(10454400000000000n);
  });

  test("timespan atom: raw ns", () => {
    expect(conn.execute("0D00:00:01")).toBe(1000000000);
    expect(conn.execute("0D01:00:00")).toBe(3600000000000);
  });
});

describe.skipIf(!up)("i64 precision policy at 2^53", () => {
  let conn: LConnection;
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
  });
  afterAll(() => conn.close());

  test("2^53-1 and 2^53 are numbers, 2^53+1 is bigint", () => {
    const below = conn.execute("9007199254740991j");
    expect(typeof below).toBe("number");
    expect(below).toBe(9007199254740991);
    // 2^53 itself is not exactly representable one past MAX_SAFE:
    // policy is bigint for anything beyond MAX_SAFE_INTEGER
    const at = conn.execute("9007199254740992j");
    expect(typeof at).toBe("bigint");
    expect(at).toBe(9007199254740992n);
    const above = conn.execute("9007199254740993j");
    expect(typeof above).toBe("bigint");
    expect(above).toBe(9007199254740993n); // no silent digit loss
  });

  test("negative side of the boundary", () => {
    expect(conn.execute("-9007199254740991j")).toBe(-9007199254740991);
    const v = conn.execute("-9007199254740993j");
    expect(typeof v).toBe("bigint");
    expect(v).toBe(-9007199254740993n);
  });

  test("bigint argument round trips exactly", () => {
    const v = conn.execute("::", J(1234567890123456789n));
    expect(v).toBe(1234567890123456789n);
    expect(conn.execute("{x-1}", J(9007199254740993n)))
      .toBe(9007199254740992n);
  });

  test("long vector mixes numbers and bigints by magnitude", () => {
    const v = conn.execute("9007199254740993 1j") as any[];
    expect(typeof v[0]).toBe("bigint");
    expect(v[0]).toBe(9007199254740993n);
    expect(typeof v[1]).toBe("number");
    expect(v[1]).toBe(1);
  });

  test("small long vectors are plain numbers", () => {
    expect(conn.execute("1 2 3j")).toEqual([1, 2, 3]);
  });

  test("long infinities and null are exact bigints", () => {
    expect(conn.execute("0Wj")).toBe(9223372036854775807n);
    expect(conn.execute("-0Wj")).toBe(-9223372036854775807n);
    expect(conn.execute("0Nj")).toBe(-9223372036854775808n);
  });

  test("vJ round trips 64-bit values exactly", () => {
    const v = conn.execute(
      "::",
      vJ(1n, -9007199254740993n, 42),
    ) as any[];
    expect(v[0]).toBe(1);
    expect(v[1]).toBe(-9007199254740993n);
    expect(v[2]).toBe(42);
  });
});

describe.skipIf(!up)("Null sentinels per type", () => {
  let conn: LConnection;
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
  });
  afterAll(() => conn.close());

  test("integer family nulls are their sentinel values", () => {
    expect(conn.execute("0N")).toBe(-2147483648);   // int null
    expect(conn.execute("0Nh")).toBe(-32768);       // short null
    expect(conn.execute("0Nj")).toBe(-9223372036854775808n); // long
  });

  test("float family nulls are NaN", () => {
    expect(conn.execute("0n")).toBeNaN();   // float null
    expect(conn.execute("0Ne")).toBeNaN();  // real null
  });

  test("symbol null is the empty string, char null a space", () => {
    expect(conn.execute("`")).toBe("");
    expect(conn.execute('" "')).toBe(" ");
  });

  test("date/datetime nulls are Invalid Date", () => {
    const d = conn.execute("0Nd") as Date;
    expect(d).toBeInstanceOf(Date);
    expect(Number.isNaN(d.getTime())).toBe(true);
    const z = conn.execute("0Nz") as Date;
    expect(z).toBeInstanceOf(Date);
    expect(Number.isNaN(z.getTime())).toBe(true);
  });

  test("raw-count temporal nulls are their int sentinels", () => {
    expect(conn.execute("0Nt")).toBe(-2147483648);  // time
    expect(conn.execute("0Nm")).toBe(-2147483648);  // month
    expect(conn.execute("0Nu")).toBe(-2147483648);  // minute
    expect(conn.execute("0Nv")).toBe(-2147483648);  // second
  });

  test("int infinities are their sentinel values", () => {
    expect(conn.execute("0W")).toBe(2147483647);
    expect(conn.execute("-0W")).toBe(-2147483647);
  });
});

describe.skipIf(!up)("IEEE edge values", () => {
  let conn: LConnection;
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
  });
  afterAll(() => conn.close());

  test("float infinities round trip both directions", () => {
    expect(conn.execute("0w")).toBe(Infinity);
    expect(conn.execute("-0w")).toBe(-Infinity);
    expect(conn.execute("::", F(Infinity))).toBe(Infinity);
    expect(conn.execute("::", F(-Infinity))).toBe(-Infinity);
  });

  test("NaN round trips both directions", () => {
    // NaN is the L null float; the Bun FFI lowers NaN f64 ARGUMENTS
    // to 0.0, so the client must ship floats bit-exactly (regression)
    expect(conn.execute("::", F(NaN))).toBeNaN();
    expect(conn.execute("{null x}", F(NaN))).toBe(true);
    expect(conn.execute("0n")).toBeNaN();
    const v = conn.execute("::", vF(NaN, 1.5)) as number[];
    expect(v[0]).toBeNaN();
    expect(v[1]).toBe(1.5);
    expect(conn.execute("{null x}", E(NaN))).toBe(true);
  });

  test("negative zero survives", () => {
    const recv = conn.execute("-1f*0f") as number;
    expect(Object.is(recv, -0)).toBe(true);
    const sent = conn.execute("::", F(-0)) as number;
    expect(Object.is(sent, -0)).toBe(true);
  });

  test("denormal float round trips", () => {
    expect(conn.execute("::", F(5e-324))).toBe(5e-324);
  });

  test("real (f32) infinities", () => {
    expect(conn.execute("0we")).toBe(Infinity);
    expect(conn.execute("-0we")).toBe(-Infinity);
  });
});

describe.skipIf(!up)("Unicode", () => {
  let conn: LConnection;
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
  });
  afterAll(() => conn.close());

  test("multibyte symbol round trips", () => {
    expect(conn.execute("::", S("café"))).toBe("café");
    expect(conn.execute("::", S("München"))).toBe("München");
  });

  test("emoji symbol round trips", () => {
    const rocket = "\u{1F680}";
    expect(conn.execute("::", S(rocket + "ship"))).toBe(rocket + "ship");
  });

  test("CJK string round trips", () => {
    const s = "東京データ";
    expect(conn.execute("::", vC(s))).toBe(s);
    // count sees BYTES (the wire is untagged bytes, UTF-8 in = out)
    expect(conn.execute("count", vC(s))).toBe(Buffer.byteLength(s));
  });

  test("emoji string round trips", () => {
    const s = "ok \u{1F44D} done";
    expect(conn.execute("::", vC(s))).toBe(s);
  });

  test("unicode symbols in vectors and dict keys", () => {
    const v = conn.execute("::", vS("α", "β", "γ"));
    expect(v).toEqual(["α", "β", "γ"]);
    const d = conn.execute("(enlist `$\"\\303\\251\")!enlist 1");
    expect(d).toEqual({ "é": 1 });
  });
});

describe.skipIf(!up)("Strings deep", () => {
  let conn: LConnection;
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
  });
  afterAll(() => conn.close());

  test("strings beyond 64KB are not truncated", () => {
    // regression: the old path copied through a fixed 64KB buffer
    // and silently returned 65535 chars
    const s = conn.execute('100000#"ab"') as string;
    expect(s.length).toBe(100000);
    expect(s.slice(0, 4)).toBe("abab");
    expect(s.slice(-2)).toBe("ab");
  });

  test("large string round trips exactly", () => {
    const big = "x".repeat(200000) + "END";
    expect(conn.execute("count", vC(big))).toBe(big.length);
    expect((conn.execute("::", vC(big)) as string).length)
      .toBe(big.length);
    expect((conn.execute("::", vC(big)) as string).slice(-3)).toBe("END");
  });

  test("interior NUL bytes survive", () => {
    // regression: the NUL-terminated constructor stopped at the
    // first \0 and sent a 1-char string
    expect(conn.execute("count", vC("a\0b"))).toBe(3);
    const rt = conn.execute("::", vC("a\0b")) as string;
    expect(rt.length).toBe(3);
    expect(rt.charCodeAt(1)).toBe(0);
  });

  test("empty string", () => {
    expect(conn.execute('""')).toBe("");
    expect(conn.execute("count", vC(""))).toBe(0);
  });
});

describe.skipIf(!up)("Empty and single-element vectors", () => {
  let conn: LConnection;
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
  });
  afterAll(() => conn.close());

  const emptys: Array<[string, string]> = [
    ["boolean", "`boolean$()"],
    ["byte", "`byte$()"],
    ["short", "`short$()"],
    ["int", "`int$()"],
    ["long", "`long$()"],
    ["real", "`real$()"],
    ["float", "`float$()"],
    ["symbol", "`symbol$()"],
    ["date", "`date$()"],
    ["time", "`time$()"],
    ["datetime", "`datetime$()"],
    ["timestamp", "`timestamp$()"],
    ["timespan", "`timespan$()"],
    ["mixed", "()"],
  ];
  for (const [name, q] of emptys) {
    test(`empty ${name} vector is []`, () => {
      expect(conn.execute(q)).toEqual([]);
    });
  }

  test("single-element vectors keep exact values", () => {
    expect(conn.execute("enlist 42")).toEqual([42]);
    expect(conn.execute("enlist 42j")).toEqual([42]);
    expect(conn.execute("enlist 2.5")).toEqual([2.5]);
    expect(conn.execute("enlist `only")).toEqual(["only"]);
    expect(conn.execute("enlist 1b")).toEqual([true]);
    expect(conn.execute("enlist 0x2a")).toEqual([42]);
    expect(conn.execute("enlist 7h")).toEqual([7]);
  });

  test("single-element temporal vectors", () => {
    const d = conn.execute("enlist 2000.01.11") as Date[];
    expect(d).toHaveLength(1);
    expect(d[0].toISOString()).toBe("2000-01-11T00:00:00.000Z");
    expect(conn.execute("enlist 12:00:00.000")).toEqual([43200000]);
  });

  test("generator-built vectors round trip exact values", () => {
    expect(conn.execute("::", vG(1, 128, 255))).toEqual([1, 128, 255]);
    expect(conn.execute("::", vH(-1, 0, 1))).toEqual([-1, 0, 1]);
    expect(conn.execute("::", vI(-5, 0, 5))).toEqual([-5, 0, 5]);
    expect(conn.execute("::", vE(0.5, -1.5))).toEqual([0.5, -1.5]);
    expect(conn.execute("::", vF(1.25, -2.5))).toEqual([1.25, -2.5]);
    expect(conn.execute("::", vS("a", "b"))).toEqual(["a", "b"]);
    expect(conn.execute("::", vT(0, 43200000))).toEqual([0, 43200000]);
  });

  test("date vector round trips as Dates", () => {
    const d = conn.execute(
      "::",
      vD(new Date(Date.UTC(2024, 0, 2)), 0),
    ) as Date[];
    expect(d[0].toISOString()).toBe("2024-01-02T00:00:00.000Z");
    expect(d[1].toISOString()).toBe("2000-01-01T00:00:00.000Z");
  });

  test("datetime vector round trips as Dates", () => {
    const when = new Date(Date.UTC(2024, 5, 15, 10, 30));
    const z = conn.execute("::", vZ(when)) as Date[];
    expect(z).toHaveLength(1);
    expect(Math.abs(z[0].getTime() - when.getTime())).toBeLessThan(2);
  });
});
