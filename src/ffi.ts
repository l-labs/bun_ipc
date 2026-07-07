import { dlopen, FFIType as t, suffix } from "bun:ffi";

// Locate liblconn.{dylib,so} — the C connector library built by
// ./build.sh from ./native/lconn.c. It speaks the L wire protocol
// over TCP; every l_* function below is a fixed-arity C entry point
// (Bun FFI cannot call variadic C functions, so the connector
// provides the l_k / l_execute1..3 / l_execute_args wrappers).
function findLib(): string {
  const local = `${import.meta.dir}/../build/liblconn.${suffix}`;
  return process.env.L_CONN_LIB ?? local;                                       // env var overrides the path
}

// def/m: compress the signature table below — each entry is
// [returnType, ...argTypes], expanded into Bun's {args, returns} shape.
const def = (ret: t, ...args: t[]) => ({ args, returns: ret });
const m = (s: Record<string, [t, ...t[]]>) =>
  Object.fromEntries(
    Object.entries(s).map(([k, [ret, ...args]]) => [k, def(ret, ...args)]),
  );

// Only the symbols actually called from src/ are declared — the same
// surface native/l_interface.h documents for C consumers. The compiled
// connector exports further entry points if you need them.
const signatures = m({
  mi0: [t.void],                                                                // one-time allocator + intern-table init

  // Connections
  l_connect: [t.i32, t.cstring, t.i32],
  l_secure_connect: [t.i32, t.cstring, t.i32, t.cstring],
  l_close_connection: [t.void, t.i32],

  // Query execution (fixed arity; args are consumed by the call)
  l_k: [t.ptr, t.i32, t.cstring],
  l_execute1: [t.ptr, t.i32, t.cstring, t.ptr],
  l_execute2: [t.ptr, t.i32, t.cstring, t.ptr, t.ptr],
  l_execute3: [t.ptr, t.i32, t.cstring, t.ptr, t.ptr, t.ptr],
  l_execute_args: [t.ptr, t.i32, t.cstring, t.ptr, t.i32],

  // Reference counting
  l_retain: [t.void, t.ptr],
  l_release: [t.void, t.ptr],

  // Introspection
  l_is_error: [t.bool, t.ptr],
  l_get_type: [t.i16, t.ptr],
  l_get_length: [t.i32, t.ptr],
  l_get_data: [t.ptr, t.ptr],                                                   // raw payload pointer: length-bounded reads (never truncates)

  // Atom value getters
  l_get_bool_value: [t.i32, t.ptr],
  l_get_byte_value: [t.i32, t.ptr],
  l_get_short_value: [t.i16, t.ptr],
  l_get_int_value: [t.i32, t.ptr],
  l_get_long_value: [t.i64, t.ptr],
  l_get_real_value: [t.f64, t.ptr],
  l_get_real_as_double_value: [t.f64, t.ptr],
  l_get_float_value: [t.f64, t.ptr],
  l_get_char_value: [t.char, t.ptr],
  l_get_symbol_value: [t.cstring, t.ptr],
  l_get_string_value: [t.cstring, t.ptr],

  // Vector element getters (no bounds checks — stay within length)
  l_get_int_at: [t.i32, t.ptr, t.i32],
  l_get_long_at: [t.i64, t.ptr, t.i32],
  l_get_float_at: [t.f64, t.ptr, t.i32],
  l_get_byte_at: [t.u8, t.ptr, t.i32],
  l_get_short_at: [t.i16, t.ptr, t.i32],
  l_get_real_as_double_at: [t.f64, t.ptr, t.i32],
  l_get_symbol_at: [t.cstring, t.ptr, t.i32],
  l_get_object_at: [t.ptr, t.ptr, t.i32],

  // Vector element setters
  l_set_int_at: [t.void, t.ptr, t.i32, t.i32],
  l_set_long_at: [t.void, t.ptr, t.i32, t.i64],
  l_set_float_at: [t.void, t.ptr, t.i32, t.f64],
  l_set_byte_at: [t.void, t.ptr, t.i32, t.u8],
  l_set_short_at: [t.void, t.ptr, t.i32, t.i16],
  l_set_real_at: [t.void, t.ptr, t.i32, t.f32],
  l_set_symbol_at: [t.void, t.ptr, t.i32, t.cstring],

  // Atom constructors
  l_new_bool: [t.ptr, t.i32],
  l_new_byte: [t.ptr, t.u8],
  l_new_short: [t.ptr, t.i16],
  l_new_int: [t.ptr, t.i32],
  l_new_long: [t.ptr, t.i64],
  l_new_real: [t.ptr, t.f32],
  l_new_float: [t.ptr, t.f64],
  l_new_char: [t.ptr, t.char],
  l_new_symbol: [t.ptr, t.cstring],
  l_new_string: [t.ptr, t.cstring],
  l_new_string_n: [t.ptr, t.ptr, t.i32],                                        // byte-counted: interior NULs survive (l_new_string stops at NUL)
  l_new_date: [t.ptr, t.i32],
  l_new_time: [t.ptr, t.i32],
  l_new_datetime: [t.ptr, t.f64],
  l_new_timestamp: [t.ptr, t.i64],
  l_new_timespan: [t.ptr, t.i64],

  // Bit-exact construction (see newFloat below)
  l_new_atom_bits: [t.ptr, t.i32, t.i64],
  l_set_bits_at: [t.void, t.ptr, t.i32, t.i64],

  // Collections
  l_new_list: [t.ptr, t.i32, t.i32],
  l_new_dict: [t.ptr, t.ptr, t.ptr],
  l_list_append_object: [t.ptr, t.ptr, t.ptr],
  l_table_to_dict: [t.ptr, t.ptr],
});

export const lib = dlopen(findLib(), signatures);

lib.symbols.mi0();                                                              // must run before any other connector call

// Bun's FFI lowers the f64/f32 ARGUMENTS NaN and -0.0 to +0.0 (the
// return direction is fine). NaN is the L null float, so that would
// silently turn nulls into zeroes. All float construction therefore
// goes through l_new_atom_bits / l_set_bits_at, which carry the
// exact IEEE bit pattern in an integer argument.
const F64 = new Float64Array(1);
const U64 = new BigUint64Array(F64.buffer);
const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
/** IEEE-754 bits of v as an f64, ready for an i64 FFI argument. */
export function f64bits(v: number): bigint {
  F64[0] = v;
  return U64[0];
}
/** IEEE-754 bits of v as an f32 (widened to bigint). */
export function f32bits(v: number): bigint {
  F32[0] = v;
  return BigInt(U32[0]);
}
export const newFloat = (v: number) =>
  lib.symbols.l_new_atom_bits(-9, f64bits(v)) as number;                        // -9 = float atom
export const newDatetime = (v: number) =>
  lib.symbols.l_new_atom_bits(-15, f64bits(v)) as number;                       // -15 = datetime atom
export const newReal = (v: number) =>
  lib.symbols.l_new_atom_bits(-8, f32bits(v)) as number;                        // -8 = real atom

// Wire type tags. A vector of type T has tag T; the corresponding
// atom has tag -T (e.g. 6 = int vector, -6 = int atom).
export const LType = Object.freeze({
  ERROR: -128,
  MIXED_LIST: 0,
  BOOLEAN: 1,
  BYTE: 4,
  SHORT: 5,
  INT: 6,
  LONG: 7,
  REAL: 8,                                                                      // f32
  FLOAT: 9,                                                                     // f64
  CHAR: 10,
  SYMBOL: 11,
  TIMESTAMP: 12,                                                                // i64 ns since 2000.01.01
  MONTH: 13,                                                                    // i32 months since 2000.01
  DATE: 14,                                                                     // i32 days since 2000.01.01
  DATETIME: 15,                                                                 // f64 fractional days since 2000.01.01
  TIMESPAN: 16,                                                                 // i64 ns duration
  MINUTE: 17,                                                                   // i32 minutes from midnight
  SECOND: 18,                                                                   // i32 seconds from midnight
  TIME: 19,                                                                     // i32 ms from midnight
  TABLE: 98,
  DICT: 99,
  LAMBDA: 100,
});
