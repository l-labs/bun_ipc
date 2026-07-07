/**
 * Structure depth: nested mixed lists, every dict shape (including
 * the non-symbol-key form that used to segfault), keyed tables,
 * wide tables, and million-row tables. L_STRESS=1 unlocks the
 * 10M-row case.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { LConnection, vI } from "../src/index";
import { PORT, serverUp } from "./helpers";

const up = serverUp();
const STRESS = process.env.L_STRESS === "1";

describe.skipIf(!up)("Nested mixed lists", () => {
  let conn: LConnection;
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
  });
  afterAll(() => conn.close());

  test("mixed list of every scalar kind", () => {
    const v = conn.execute('(1;2.5;`sym;"str";1b;0x2a)') as any[];
    expect(v[0]).toBe(1);
    expect(v[1]).toBe(2.5);
    expect(v[2]).toBe("sym");
    expect(v[3]).toBe("str");
    expect(v[4]).toBe(true);
    expect(v[5]).toBe(42);
  });

  test("deep nesting survives exactly", () => {
    const v = conn.execute("(1;(2;(3;(4;`deep))))") as any[];
    expect(v[0]).toBe(1);
    expect(v[1][0]).toBe(2);
    expect(v[1][1][0]).toBe(3);
    expect(v[1][1][1]).toEqual([4, "deep"]);
  });

  test("mixed list holding typed vectors", () => {
    const v = conn.execute("(1 2 3;`a`b;1.5 2.5)") as any[];
    expect(v[0]).toEqual([1, 2, 3]);
    expect(v[1]).toEqual(["a", "b"]);
    expect(v[2]).toEqual([1.5, 2.5]);
  });

  test("list of tables", () => {
    const v = conn.execute("(([]a:1 2);([]b:`x`y`z))") as any[];
    expect(v[0]).toHaveLength(2);
    expect(v[0][0].a).toBe(1);
    expect(v[1]).toHaveLength(3);
    expect(v[1][2].b).toBe("z");
  });
});

describe.skipIf(!up)("Dictionaries deep", () => {
  let conn: LConnection;
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
  });
  afterAll(() => conn.close());

  test("int-keyed dict becomes [key,value] pairs", () => {
    // regression: this exact shape used to segfault the process
    // (typed key vector walked with the object getter)
    expect(conn.execute("1 2!3 4")).toEqual([[1, 3], [2, 4]]);
  });

  test("float- and date-keyed dicts convert per element", () => {
    expect(conn.execute("1.5 2.5!`a`b")).toEqual([[1.5, "a"], [2.5, "b"]]);
    const pairs = conn.execute("(2000.01.01 2000.01.02)!10 20") as any[];
    expect(pairs[0][0]).toBeInstanceOf(Date);
    expect(pairs[0][1]).toBe(10);
  });

  test("char-vector values give one char per key", () => {
    // regression: char values also used to hit the object getter
    expect(conn.execute('`a`b!"xy"')).toEqual({ a: "x", b: "y" });
  });

  test("dict with long values follows the i64 policy", () => {
    const d = conn.execute("`small`big!1 9007199254740993j") as any;
    expect(d.small).toBe(1);
    expect(d.big).toBe(9007199254740993n);
  });

  test("dict with date values gives Dates", () => {
    const d = conn.execute("`a`b!2000.01.01 2000.01.02") as any;
    expect(d.a).toBeInstanceOf(Date);
    expect(d.b.toISOString()).toBe("2000-01-02T00:00:00.000Z");
  });

  test("dict of mixed values recurses", () => {
    const d = conn.execute('`x`y`z!(1 2 3;"text";`a`b!(1;2.5))') as any;
    expect(d.x).toEqual([1, 2, 3]);
    expect(d.y).toBe("text");
    expect(d.z).toEqual({ a: 1, b: 2.5 });
  });

  test("sending a JS object round trips as a dict", () => {
    const sent = { alpha: [1, 2, 3], beta: [1.5, 2.5, 3.5] };
    const back = conn.execute("::", sent) as any;
    expect(back.alpha).toEqual([1, 2, 3]);
    expect(back.beta).toEqual([1.5, 2.5, 3.5]);
  });
});

describe.skipIf(!up)("Tables deep", () => {
  let conn: LConnection;
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
  });
  afterAll(() => conn.close());

  test("empty table is []", () => {
    expect(conn.execute("([] a:`int$(); b:`symbol$())")).toEqual([]);
  });

  test("every column type converts per the type table", () => {
    const t = conn.execute(
      "([]i:1 2;j:1 9007199254740993j;f:1.5 2.5;s:`a`b;b:10b;" +
        'c:"xy";d:2000.01.01 2000.01.02)',
    ) as any[];
    expect(t).toHaveLength(2);
    expect(t[0].i).toBe(1);
    expect(t[0].j).toBe(1);                     // safe long: number
    expect(t[1].j).toBe(9007199254740993n);     // unsafe long: bigint
    expect(t[0].f).toBe(1.5);
    expect(t[1].s).toBe("b");
    expect(t[0].b).toBe(true);
    expect(t[1].b).toBe(false);
    expect(t[0].c).toBe("x");
    expect(t[0].d).toBeInstanceOf(Date);        // date cell: Date
    expect(t[1].d.toISOString()).toBe("2000-01-02T00:00:00.000Z");
  });

  test("datetime column cells are Dates", () => {
    const t = conn.execute(
      "([]z:2000.01.01T06:00:00.000 2000.01.01T18:00:00.000)",
    ) as any[];
    expect(t[0].z).toBeInstanceOf(Date);
    expect(t[0].z.getTime()).toBe(Date.UTC(2000, 0, 1, 6));
    expect(t[1].z.getTime()).toBe(Date.UTC(2000, 0, 1, 18));
  });

  test("nested list column converts per row", () => {
    const t = conn.execute("([]k:`a`b;v:(1 2 3;enlist 9))") as any[];
    expect(t[0].v).toEqual([1, 2, 3]);
    expect(t[1].v).toEqual([9]);
  });

  test("200-column table", () => {
    // build a 200-key dict in JS, ship it, flip server-side
    const wide: Record<string, any> = {};
    for (let i = 0; i < 200; i++) wide[`c${i}`] = vI(i, i + 1, i + 2);
    conn.set("wide200", wide);
    conn.execute("wide200: flip wide200");
    expect(conn.execute("count cols wide200")).toBe(200);
    const t = conn.execute("select from wide200") as any[];
    expect(t).toHaveLength(3);
    expect(Object.keys(t[0])).toHaveLength(200);
    for (let i = 0; i < 200; i++) {
      expect(t[0][`c${i}`]).toBe(i);
      expect(t[2][`c${i}`]).toBe(i + 2);
    }
    conn.execute("delete wide200 from `.");
  });
});

describe.skipIf(!up)("Keyed tables deep", () => {
  let conn: LConnection;
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
  });
  afterAll(() => conn.close());

  test("single-key table: row lookup and column arrays", () => {
    const r = conn.execute("([k:`x`y`z] v:10 20 30; w:1.5 2.5 3.5)");
    expect(r.k).toEqual(["x", "y", "z"]);
    expect(r.v).toEqual([10, 20, 30]);
    expect(r.x).toEqual({ k: "x", v: 10, w: 1.5 });
    expect(r.z.w).toBe(3.5);
  });

  test("multi-key rows join keys with |", () => {
    const r = conn.execute(
      "([a:`p`p`q;b:1 2 1] v:100 200 300)",
    );
    expect(r["p|1"].v).toBe(100);
    expect(r["p|2"].v).toBe(200);
    expect(r["q|1"].v).toBe(300);
  });

  test("by-clause result is a keyed table", () => {
    conn.execute("skt:([]s:`a`a`b`b`b;q:1 2 3 4 5)");
    const r = conn.execute("select total:sum q by s from skt");
    expect(r.s).toEqual(["a", "b"]);
    expect(r.total).toEqual([3, 12]);
    conn.execute("delete skt from `.");
  });
});

describe.skipIf(!up)("Million-row tables", () => {
  let conn: LConnection;
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
  });
  afterAll(() => conn.close());

  test(
    "1M-row table converts completely and correctly",
    () => {
      const t = conn.execute(
        "([]a:til 1000000;b:1000000?100.0;s:1000000#`x`y`z)",
      ) as any[];
      expect(t).toHaveLength(1000000);
      expect(t[0].a).toBe(0);
      expect(t[999999].a).toBe(999999);
      expect(t[500000].a).toBe(500000);
      expect(typeof t[123456].b).toBe("number");
      expect(["x", "y", "z"]).toContain(t[999999].s);
    },
    120000,
  );

  test(
    "1M-element vector round trip",
    () => {
      const v = conn.execute("til 1000000") as number[];
      expect(v).toHaveLength(1000000);
      expect(v[999999]).toBe(999999);
      expect(conn.execute("sum til 1000000")).toBe(499999500000);
    },
    120000,
  );

  test.skipIf(!STRESS)(
    "10M-row table (L_STRESS=1)",
    () => {
      const t = conn.execute(
        "([]a:til 10000000;b:10000000?100.0)",
      ) as any[];
      expect(t).toHaveLength(10000000);
      expect(t[9999999].a).toBe(9999999);
    },
    600000,
  );
});
