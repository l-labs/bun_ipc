# l-bun

Bun client for the L database. Talks to a running L server over TCP
through a small vendored C connector, loaded via `bun:ffi`.

## Quickstart

```bash
l -p 5001 &     # start an L server
bun install     # postinstall compiles build/liblconn.{dylib,so}
```

```typescript
import { LConnection, I, vF, vI, vS } from "@l-labs/bun";

const conn = LConnection.connect("localhost", 5001);
conn.execute("1+1"); // 2
conn.execute("sum", vI(1, 2, 3)); // 6
conn.execute("trade:([]sym:`A`B;price:1.5 2.5)");
conn.execute("select from trade where price>2"); // [{sym:"B", ...}]
conn.set("xs", vF(1.5, 2.5)); // server-side var
conn.close();
```

Calls are synchronous; server errors throw `Error` whose `message`
is exactly the server's error symbol (`"type"`, `"length"`,
`"rank"`, `"domain"`, a signalled symbol, or the name of an
undefined variable) and the connection stays usable. For exact wire
types use the generators: atoms `B G H I J E F C S D T Z`, vectors
`vG vH vI vJ vE vF vS vD vT vZ`, char vector `vC(string)`. See
`examples/quickstart.ts`.

## Type mapping: L → JavaScript

| L type                      | Tag      | JavaScript                  |
| --------------------------- | -------- | --------------------------- |
| boolean                     | 1        | `boolean`                   |
| byte, short, int            | 4-6      | `number`                    |
| long                        | 7        | `number`, or `bigint` beyond ±(2^53-1) |
| real, float                 | 8, 9     | `number`                    |
| char vector, symbol         | 10, 11   | `string` (any length)       |
| timestamp, timespan         | 12, 16   | raw i64 ns: `number`, or `bigint` beyond ±(2^53-1) |
| month, minute, second, time | 13,17-19 | `number` (raw count)        |
| date, datetime              | 14, 15   | `Date` (UTC)                |
| mixed list                  | 0        | `any[]`                     |
| table                       | 98       | array of row objects        |
| dict (symbol keys)          | 99       | object                      |
| dict (other keys)           | 99       | `[key, value]` pairs        |
| keyed table                 | 99       | row map + column arrays     |
| function/primitive          | 100+     | `null` (projections/compositions convert as lists) |

The same mapping applies everywhere a value can appear: atoms,
vector elements, dict keys and values, and table cells. 64-bit
integers (long/timestamp/timespan) come back as `number` while the
value is exactly representable and as `bigint` past that, so no
digit is ever silently lost; send exact large values with
`J(123n)`/`vJ(...)`.

## Null sentinels: L null → JavaScript

| L null                  | JavaScript                      |
| ----------------------- | ------------------------------- |
| `0N` (int)              | `-2147483648`                   |
| `0Nh` (short)           | `-32768`                        |
| `0Nj` (long)            | `-9223372036854775808n`         |
| `0n`, `0Ne`             | `NaN`                           |
| `` ` `` (symbol)        | `""`                            |
| `" "` (char)            | `" "`                           |
| `0Nd`, `0Nz`            | `Invalid Date`                  |
| `0Nt` `0Nm` `0Nu` `0Nv` | `-2147483648` (raw count)       |
| `0Np`, `0Nn`            | `-9223372036854775808n`         |

Int infinities arrive as their sentinel values (`0W` →
`2147483647`); float infinities as `±Infinity`. `NaN` and `-0`
round-trip bit-exactly in both directions (the connector ships
floats by bit pattern because Bun's FFI mangles NaN/-0 float
arguments).

Plain JS arguments convert the other way: number → int/float atom,
string → symbol (1-char string → char atom), boolean, Date →
datetime, bigint via `J()`, arrays → vectors, objects → dicts.

## Tests

```bash
L_TEST_PORT=5001 bun test    # skipped if no server listens
L_STRESS=1 bun test          # adds the 10M-row stress case
L_BIN=/path/to/l bun test    # enables server-kill robustness tests
```

The suite covers error-message content for the whole server error
taxonomy, exact round trips for every constructible type (including
null sentinels, IEEE edges and the 2^53 boundary), structure depth
(nested lists, all dict shapes, keyed/wide/million-row tables),
FFI hazards in crash-isolated subprocesses, leak loops checked
against the connector's own allocator counters, and mid-connection
server-death robustness.
