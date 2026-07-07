export { LConnection, jsToL, lToJs } from "./connection";
export { lib, LType } from "./ffi";
import { lib, LType, newFloat, newDatetime, newReal, f64bits, f32bits }
  from "./ffi";

// A generator is a zero-argument closure that builds a fresh K object
// each time it is called. Objects are created with refcount 0 and are
// consumed by the execute call, so a generator can be reused freely
// without double-free risk — each use makes a new object.
export type LGenerator = () => number;

const S0 = lib.symbols;                                                         // shorthand for the FFI symbol table

// The L epoch (2000.01.01) in JavaScript ms; see connection.ts.
const L_EPOCH_MS = Date.UTC(2000, 0, 1);
const MS_PER_DAY = 86400000;

// Date|number coercions shared by atom and vector constructors:
const toDays = (
  v: Date | number,                                                             // date: whole days since the L epoch
) =>
  typeof v === "number"
    ? v
    : Math.floor((v.getTime() - L_EPOCH_MS) / MS_PER_DAY);
const toDayFrac = (
  v: Date | number,                                                             // datetime: fractional days since epoch
) => (typeof v === "number" ? v : (v.getTime() - L_EPOCH_MS) / MS_PER_DAY);
const toMs = (
  v: Date | number,                                                             // time: milliseconds from midnight (local)
) =>
  typeof v === "number"
    ? v
    : v.getHours() * 3600000 +
      v.getMinutes() * 60000 +
      v.getSeconds() * 1000 +
      v.getMilliseconds();

// ── Atom generators ─────────────────────────────────────────────────
// One per wire type; the letter names follow the type alphabet
// (B bool, G byte, H short, I int, J long, E real, F float, C char,
//  S symbol, D date, T time, Z datetime).

export const B = (v: boolean): LGenerator =>
  () => S0.l_new_bool(v ? 1 : 0) as number;
export const G = (v: number): LGenerator =>
  () => S0.l_new_byte(v) as number;
export const H = (v: number): LGenerator =>
  () => S0.l_new_short(v) as number;
export const I = (v: number): LGenerator =>
  () => S0.l_new_int(v) as number;
export const J = (v: number | bigint): LGenerator =>
  () => S0.l_new_long(typeof v === "bigint" ? v : BigInt(v)) as number;
export const E = (v: number): LGenerator =>
  () => newReal(v);                                                             // bit-exact: f32 args lose NaN/-0 in the FFI
export const F = (v: number): LGenerator =>
  () => newFloat(v);                                                            // bit-exact: f64 args lose NaN/-0 in the FFI
export const C = (v: string): LGenerator =>
  () => S0.l_new_char(v.charCodeAt(0) | 0) as number;
export const S = (v: string): LGenerator =>
  () => S0.l_new_symbol(Buffer.from(v + "\0")) as number;
export const D = (v: Date | number): LGenerator =>
  () => S0.l_new_date(toDays(v)) as number;
export const T = (v: Date | number): LGenerator =>
  () => S0.l_new_time(toMs(v)) as number;
export const Z = (v: Date | number): LGenerator =>
  () => newDatetime(toDayFrac(v));                                              // bit-exact (see F)

// ── Vector generators ───────────────────────────────────────────────
// vec() folds the shared pattern: allocate a typed vector of the
// final length, then store each (coerced) element in place.

function vec<V>(
  type: number,                                                                 // wire type tag of the vector
  set: (list: number, i: number, v: any) => void,                               // element store
  coerce: (v: V) => any = (v) => v,                                             // input mapping
) {
  return (...values: V[]): LGenerator =>
    () => {
      const list = S0.l_new_list(type, values.length) as number;
      for (let i = 0; i < values.length; i++) {
        set(list, i, coerce(values[i]));
      }
      return list;                                                              // refcount 0, ready for consumption
    };
}

const setI = (l: number, i: number, v: number) => S0.l_set_int_at(l, i, v);
const setF = (l: number, i: number, v: number) =>
  S0.l_set_bits_at(l, i, f64bits(v));                                           // bit-exact f64 store (see F)

export const vG = vec<number>(LType.BYTE, (l, i, v) =>
  S0.l_set_byte_at(l, i, v),
);
export const vH = vec<number>(LType.SHORT, (l, i, v) =>
  S0.l_set_short_at(l, i, v),
);
export const vI = vec<number>(LType.INT, setI);
export const vJ = vec<number | bigint>(
  LType.LONG,
  (l, i, v) => S0.l_set_long_at(l, i, v),
  (v) => (typeof v === "bigint" ? v : BigInt(v)),
);
export const vE = vec<number>(LType.REAL, (l, i, v) =>
  S0.l_set_bits_at(l, i, f32bits(v)),                                           // bit-exact f32 store (see E)
);
export const vF = vec<number>(LType.FLOAT, setF);
export const vS = vec<string>(
  LType.SYMBOL,
  (l, i, v) => S0.l_set_symbol_at(l, i, v),
  (v) => Buffer.from(v + "\0"),
);
export const vD = vec<Date | number>(LType.DATE, setI, toDays);
export const vT = vec<Date | number>(LType.TIME, setI, toMs);
export const vZ = vec<Date | number>(LType.DATETIME, setF, toDayFrac);

// A char vector is a string on the wire, so it takes one argument.
// Byte-counted (l_new_string_n): interior NUL characters survive,
// where the NUL-terminated l_new_string would silently truncate.
export const vC = (value: string): LGenerator =>
  () => {
    const b = Buffer.from(value, "utf8");
    return S0.l_new_string_n(b, b.byteLength) as number;
  };
