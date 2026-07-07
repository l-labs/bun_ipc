import { CString } from "bun:ffi";
import { lib, LType, newFloat, newDatetime } from "./ffi";

// The L epoch (2000.01.01) in JavaScript milliseconds-since-1970.
// Dates and datetimes on the wire count days from this epoch.
const L_EPOCH_MS = Date.UTC(2000, 0, 1);
const MS_PER_DAY = 86400000;

// 64-bit integer policy (long/timestamp/timespan): values inside the
// IEEE-754 exact-integer range come back as number; anything outside
// comes back as bigint so no digit is ever silently lost. The same
// rule applies to atoms, vector elements, dict values and table cells.
const J_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
function j2js(v: bigint): number | bigint {
  return v >= -J_SAFE && v <= J_SAFE ? Number(v) : v;
}

/** A connection to an L server over TCP. */
export class LConnection {
  private handle: number;
  private connected: boolean = false;

  constructor(handle: number) {
    this.handle = handle;
    this.connected = true;
  }

  // The connector returns a positive socket descriptor on success,
  // -1 when the TCP connect fails, and 0 when the server accepts the
  // socket but refuses the handshake (closes without the ACK byte).
  // 0 must be rejected too: treating it as a handle would aim every
  // later query at file descriptor 0.
  static connect(host: string, port: number): LConnection {
    const handle = lib.symbols.l_connect(
      Buffer.from(host + "\0"),
      port,
    ) as number;
    if (handle <= 0) {
      throw new Error(`Failed to connect to ${host}:${port}`);
    }
    return new LConnection(handle);
  }

  /** Connect with "user:password" credentials (sent in cleartext). */
  static secureConnect(
    host: string,
    port: number,
    credentials: string,
  ): LConnection {
    const handle = lib.symbols.l_secure_connect(
      Buffer.from(host + "\0"),
      port,
      Buffer.from(credentials + "\0"),
    ) as number;
    if (handle <= 0) {
      throw new Error(`Failed to secure connect to ${host}:${port}`);
    }
    return new LConnection(handle);
  }

  /**
   * Run a query synchronously and return the result as a JavaScript
   * value. Extra args are converted (or generated, see index.ts) into
   * K objects and applied to the query; the C call consumes them.
   */
  execute(query: string, ...args: any[]): any {
    if (!this.connected) throw new Error("Connection is closed");

    const kArgs = args.map(jsToL).filter((arg) => arg !== null);

    // Once an execute call starts, ownership of every arg passes to
    // the C side; only clean up if we fail before that point.
    let executionStarted = false;
    try {
      const queryBuf = Buffer.from(query + "\0");
      let result;
      if (kArgs.length === 0) {
        // no surviving args (none given, or all converted to null):
        // ship the bare query text
        executionStarted = true;
        result = lib.symbols.l_k(this.handle, queryBuf);
      } else if (kArgs.length <= 3) {
        executionStarted = true;
        const execFn = [
          lib.symbols.l_execute1,
          lib.symbols.l_execute2,
          lib.symbols.l_execute3,
        ][kArgs.length - 1];
        result = execFn(this.handle, queryBuf, ...kArgs);
      } else {
        // 4+ args go through a pointer array
        const argBuffer = Buffer.alloc(kArgs.length * 8);
        kArgs.forEach((arg, i) => {
          argBuffer.writeBigUInt64LE(BigInt(arg || 0), i * 8);
        });
        executionStarted = true;
        result = lib.symbols.l_execute_args(
          this.handle,
          queryBuf,
          argBuffer,
          kArgs.length,
        );
      }

      if (!result) throw new Error("Query execution failed");

      if (lib.symbols.l_is_error(result)) {
        const error = extractError(result);
        lib.symbols.l_release(result);
        throw new Error(error as string);
      }

      const jsResult = lToJs(result);
      lib.symbols.l_release(result);
      return jsResult;
    } finally {
      if (!executionStarted) {
        kArgs.forEach((arg) => {
          if (arg && typeof arg === "number") {
            lib.symbols.l_release(arg);
          }
        });
      }
    }
  }

  /** Assign a server-side variable: conn.set("t", value). */
  set(varName: string, value: any): void {
    if (!this.connected) throw new Error("Connection is closed");

    const kValue = jsToL(value);
    if (!kValue || typeof kValue !== "number") {
      throw new Error("Failed to convert value to a K object");
    }

    // l_execute1 consumes kValue unconditionally — including when the
    // server answers with an error or the call fails after shipping.
    // Releasing it again on those paths double-frees: the freed block
    // re-enters the allocator twice, two later objects alias the same
    // memory, and values silently corrupt. Never touch kValue after
    // this call.
    const result = lib.symbols.l_execute1(
      this.handle,
      Buffer.from(`\`${varName} set\0`),
      kValue,
    );
    if (!result) throw new Error(`Failed to set variable ${varName}`);
    if (lib.symbols.l_is_error(result)) {
      const error = extractError(result);
      lib.symbols.l_release(result);
      throw new Error(error as string);
    }
    lib.symbols.l_release(result);
  }

  close(): void {
    if (this.connected) {
      lib.symbols.l_close_connection(this.handle);
      this.connected = false;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }
}

// Atom constructors, keyed by conversion target. Floats go through
// the bit-exact path (see ffi.ts): plain f64 arguments lose NaN/-0.
const typeCtors = {
  bool: lib.symbols.l_new_bool,
  int: lib.symbols.l_new_int,
  float: newFloat,
  char: lib.symbols.l_new_char,
  symbol: lib.symbols.l_new_symbol,
  datetime: newDatetime,
};

// Raw vector-element getters for the types whose JS value is the raw
// stored number (elemToJs handles every type that needs conversion).
// Temporal counts stay raw: time/month/minute/second per the README.
const typeGetters: Record<number, (...args: any[]) => any> = {
  [LType.BYTE]: lib.symbols.l_get_byte_at,
  [LType.SHORT]: lib.symbols.l_get_short_at,
  [LType.INT]: lib.symbols.l_get_int_at,
  [LType.REAL]: lib.symbols.l_get_real_as_double_at,
  [LType.FLOAT]: lib.symbols.l_get_float_at,
  [LType.TIME]: lib.symbols.l_get_int_at,
  [LType.MONTH]: lib.symbols.l_get_int_at,
  [LType.MINUTE]: lib.symbols.l_get_int_at,
  [LType.SECOND]: lib.symbols.l_get_int_at,
};

// Container tags whose payload really holds child K objects. Only
// these may be walked with l_get_object_at — on any other typed
// vector that call would reinterpret raw data as pointers and crash.
const PROJECTION = 104;
const COMPOSITION = 105;
function holdsObjects(type: number): boolean {
  return (
    type === LType.MIXED_LIST || type === PROJECTION || type === COMPOSITION
  );
}

/**
 * Convert element i of an L vector into a JavaScript value. This is
 * the single shared element path — lists, dict values, dict keys and
 * table cells all go through it, so every container agrees with the
 * README type table (symbols as string, booleans as boolean, dates
 * and datetimes as Date, 64-bit ints under the j2js policy).
 */
function elemToJs(vec: any, type: number, i: number): any {
  switch (type) {
    case LType.BOOLEAN:
      return (lib.symbols.l_get_byte_at(vec, i) as number) !== 0;
    case LType.CHAR:
      return String.fromCharCode(
        lib.symbols.l_get_byte_at(vec, i) as number,
      );
    case LType.SYMBOL:
      return String(lib.symbols.l_get_symbol_at(vec, i));
    case LType.DATE:
      return new Date(
        L_EPOCH_MS +
          (lib.symbols.l_get_int_at(vec, i) as number) * MS_PER_DAY,
      );
    case LType.DATETIME:
      return new Date(
        L_EPOCH_MS +
          (lib.symbols.l_get_float_at(vec, i) as number) * MS_PER_DAY,
      );
    case LType.LONG:
    case LType.TIMESTAMP:
    case LType.TIMESPAN:
      return j2js(lib.symbols.l_get_long_at(vec, i) as bigint);
    default: {
      const getter = typeGetters[type];
      if (getter) return getter(vec, i);
      if (holdsObjects(type)) {
        return lToJs(lib.symbols.l_get_object_at(vec, i));
      }
      return null; // unknown typed payload: no safe JS mapping
    }
  }
}

/**
 * Convert a JavaScript value into a K object pointer (refcount 0,
 * ready to be consumed by an execute call). Returns null for values
 * that have no conversion.
 */
export function jsToL(value: any): number | null {
  if (value === null || value === undefined) return 0;

  // A generator (zero-arg function from index.ts) creates its own K
  if (typeof value === "function" && value.length === 0) {
    const ptr = value();
    return typeof ptr === "number" ? ptr : 0;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return lib.symbols.l_new_list(0, 0) as number;

    const firstElem = value[0];
    const elemType = typeof firstElem;
    const homogeneous = value.every((v) => typeof v === elemType);

    if (homogeneous) {
      // Array of generators: run each and collect into a mixed list
      if (elemType === "function" && value.every((v) => v.length === 0)) {
        let list = lib.symbols.l_new_list(0, 0) as number;
        for (const gen of value) {
          const obj = gen();
          if (obj !== null) {
            list = lib.symbols.l_list_append_object(list, obj) as number;
          }
        }
        return list;
      }

      // Typed vector: pick the element type from the first value
      let listType = 0;
      if (elemType === "number") {
        listType = value.every(Number.isInteger) ? LType.INT : LType.FLOAT;
      } else if (elemType === "string") {
        listType = LType.SYMBOL;
      } else if (
        elemType === "object" &&
        value.every((v) => v instanceof Date)
      ) {
        listType = LType.DATETIME;
      }

      let list = lib.symbols.l_new_list(listType, 0) as number;
      for (const elem of value) {
        const atom = jsToL(elem);
        if (atom) {
          list = lib.symbols.l_list_append_object(list, atom) as number;
        }
      }
      return list;
    }

    // Heterogeneous: mixed list of recursively converted elements
    let list = lib.symbols.l_new_list(0, 0) as number;
    for (const elem of value) {
      const actual =
        typeof elem === "function" && elem.length === 0 ? elem() : elem;
      const kElem = jsToL(actual);
      if (kElem !== null) {
        list = lib.symbols.l_list_append_object(list, kElem) as number;
      }
    }
    return list;
  }

  // Plain objects become dicts with symbol keys
  if (typeof value === "object" && !(value instanceof Date)) {
    const keys = Object.keys(value);
    let keyList = lib.symbols.l_new_list(LType.SYMBOL, 0) as number;
    let valueList = lib.symbols.l_new_list(0, 0) as number;
    for (const key of keys) {
      const atom = lib.symbols.l_new_symbol(
        Buffer.from(key + "\0"),
      ) as number;
      keyList = lib.symbols.l_list_append_object(keyList, atom) as number;
      const kValue = jsToL(value[key]);
      if (kValue !== null && typeof kValue === "number") {
        valueList = lib.symbols.l_list_append_object(
          valueList,
          kValue,
        ) as number;
      }
    }
    return lib.symbols.l_new_dict(keyList, valueList) as number;
  }

  // Scalars
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? (typeCtors.int(value) as number)
      : (typeCtors.float(value) as number);
  }
  if (typeof value === "string") {
    return value.length === 1                                                   // single char -> char atom, else symbol
      ? (typeCtors.char(value.charCodeAt(0)) as number)
      : (typeCtors.symbol(Buffer.from(value + "\0")) as number);
  }
  if (typeof value === "boolean") {
    return typeCtors.bool(value ? 1 : 0) as number;
  }
  if (value instanceof Date) {
    const days = (value.getTime() - L_EPOCH_MS) / MS_PER_DAY;
    return typeCtors.datetime(days) as number;
  }

  return null;
}

// Atom value getters keyed by atom type (the negated tag). The int
// temporal types share one raw-int getter; date and datetime become
// JS Dates; the i64 types follow the j2js number-or-bigint policy.
const atomGetters: Record<number, (o: any) => any> = {
  [LType.BOOLEAN]: (o) => lib.symbols.l_get_bool_value(o) !== 0,
  [LType.BYTE]: (o) => lib.symbols.l_get_byte_value(o),
  [LType.SHORT]: (o) => lib.symbols.l_get_short_value(o),
  [LType.REAL]: (o) => lib.symbols.l_get_real_as_double_value(o),
  [LType.FLOAT]: (o) => lib.symbols.l_get_float_value(o),
  [LType.CHAR]: (o) =>
    String.fromCharCode(lib.symbols.l_get_char_value(o) as number),
  [LType.SYMBOL]: (o) => String(lib.symbols.l_get_symbol_value(o)),
  [LType.DATE]: (o) =>
    new Date(
      L_EPOCH_MS + (lib.symbols.l_get_int_value(o) as number) * MS_PER_DAY,
    ),
  [LType.DATETIME]: (o) => {
    const days = lib.symbols.l_get_float_value(o) as number;
    return new Date(L_EPOCH_MS + days * MS_PER_DAY);
  },
};
for (const t of [LType.INT, LType.TIME, LType.MONTH,
  LType.MINUTE, LType.SECOND]) {
  atomGetters[t] = (o) => lib.symbols.l_get_int_value(o) as number;
}
for (const t of [LType.LONG, LType.TIMESTAMP, LType.TIMESPAN]) {
  atomGetters[t] = (o) => j2js(lib.symbols.l_get_long_value(o) as bigint);
}

/** Pull the message text out of an error object (type -128). */
function extractError(errorObj: any): string | null {
  if (!errorObj) return null;
  const type = lib.symbols.l_get_type(errorObj) as number;
  if (type === LType.ERROR) {
    // error payload is an interned symbol holding the message
    return String(lib.symbols.l_get_symbol_value(errorObj));
  }
  const str = lib.symbols.l_get_string_value(errorObj);
  return str ? String(str) : "Unknown error";
}

/** Convert a K object pointer into a JavaScript value. */
export function lToJs(kObj: any): any {
  if (!kObj) return null;

  const type = lib.symbols.l_get_type(kObj) as number;

  // Atoms carry negative type tags
  if (type < 0) {
    const getter = atomGetters[-type];
    return getter
      ? getter(kObj)
      : (lib.symbols.l_get_int_value(kObj) as number);
  }

  if (type === LType.DICT) return convertDict(kObj);
  if (type === LType.TABLE) return convertTable(kObj);
  // Function-valued results (primitives, adverb-derived forms) carry
  // an opcode, not elements — their length field is meaningless, so
  // walking them as lists reads out of bounds. Projections and
  // compositions are real child-holding containers and still convert.
  if (type >= LType.LAMBDA && !holdsObjects(type)) return null;
  return convertList(kObj, type);                                               // any other non-negative tag is list-like
}

function convertDict(kObj: any): any {
  const keys = lib.symbols.l_get_object_at(kObj, 0);
  const values = lib.symbols.l_get_object_at(kObj, 1);
  if (!keys || !values) return {};

  const keyCount = lib.symbols.l_get_length(keys) as number;
  const keysType = lib.symbols.l_get_type(keys) as number;
  const valuesType = lib.symbols.l_get_type(values) as number;

  // table!table means a keyed table, not a plain dict
  if (keysType === LType.TABLE && valuesType === LType.TABLE) {
    return convertKeyedTable(keys, values);
  }

  if (keysType === LType.SYMBOL) {
    const result: Record<string, any> = {};
    for (let i = 0; i < keyCount; i++) {
      const key = String(lib.symbols.l_get_symbol_at(keys, i));
      result[key] = elemToJs(values, valuesType, i);
    }
    return result;
  }

  // Non-symbol keys: fall back to an array of [key, value] pairs
  const pairs: Array<[any, any]> = [];
  for (let i = 0; i < keyCount; i++) {
    pairs.push([
      elemToJs(keys, keysType, i),
      elemToJs(values, valuesType, i),
    ]);
  }
  return pairs;
}

// A keyed table comes back as one object per key row merged with its
// value row, plus per-column arrays for column-oriented access.
function convertKeyedTable(keys: any, values: any): any {
  const keyTable = lToJs(keys) as any[];
  const valueTable = lToJs(values) as any[];
  if (!Array.isArray(keyTable) || !Array.isArray(valueTable)) return {};

  const result: Record<string, any> = {};
  const keyColNames = keyTable.length > 0 ? Object.keys(keyTable[0]) : [];

  for (let i = 0; i < keyTable.length; i++) {
    const keyStr =
      keyColNames.length === 1
        ? String(keyTable[i][keyColNames[0]])
        : keyColNames.map((col) => String(keyTable[i][col])).join("|");
    result[keyStr] = { ...keyTable[i], ...valueTable[i] };
  }

  for (const col of keyColNames) {
    result[col] = keyTable.map((row) => row[col]);
  }
  if (valueTable.length > 0) {
    for (const col of Object.keys(valueTable[0])) {
      result[col] = valueTable.map((row) => row[col]);
    }
  }
  return result;
}

// A simple table becomes an array of row objects: [{col: v, ...}, ...]
// Column names, handles and types are resolved once, then every cell
// goes through the shared elemToJs path.
function convertTable(kObj: any): any[] {
  const dict = lib.symbols.l_table_to_dict(kObj);
  if (!dict) return [];

  const keys = lib.symbols.l_get_object_at(dict, 0);
  const values = lib.symbols.l_get_object_at(dict, 1);
  if (!keys || !values) return [];

  const colCount = lib.symbols.l_get_length(keys) as number;
  if (colCount === 0) return [];

  const cols: Array<{ name: string; data: any; type: number }> = [];
  for (let c = 0; c < colCount; c++) {
    const data = lib.symbols.l_get_object_at(values, c);
    cols.push({
      name: String(lib.symbols.l_get_symbol_at(keys, c)),
      data,
      type: data ? (lib.symbols.l_get_type(data) as number) : 0,
    });
  }

  const rowCount = cols[0].data
    ? (lib.symbols.l_get_length(cols[0].data) as number)
    : 0;
  const rows: any[] = [];
  for (let r = 0; r < rowCount; r++) {
    const row: Record<string, any> = {};
    for (const col of cols) {
      row[col.name] = col.data ? elemToJs(col.data, col.type, r) : null;
    }
    rows.push(row);
  }
  return rows;
}

function convertList(kObj: any, type: number): any {
  const count = lib.symbols.l_get_length(kObj) as number;

  // A char vector is a string. Read it straight from the payload,
  // bounded by the element count — the l_get_string_value path copies
  // through a fixed 64KB buffer and silently truncates longer text.
  if (type === LType.CHAR) {
    if (count === 0) return "";
    const data = lib.symbols.l_get_data(kObj) as number;
    return new CString(data, 0, count).toString();
  }

  const result: any[] = [];
  for (let i = 0; i < count; i++) {
    result.push(elemToJs(kObj, type, i));
  }
  return result;
}
