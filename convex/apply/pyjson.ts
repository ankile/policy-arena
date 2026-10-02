/**
 * Python-`json`-compatible load/dump for apply-pipeline artifacts.
 *
 * The Python outcome_editor reads its sidecars with json.loads and writes them
 * with specific json.dumps settings. A file the TS apply leaves semantically
 * unchanged must come out BYTE-identical, or every re-apply churns the HF repo:
 *  - progress record:      json.dump(indent=2)                 (insertion order)
 *  - results.json:         json.dumps(indent=2, sort_keys=True) + "\n"
 *  - meta/stats.json:      json.dumps(indent=4)                (insertion order)
 *  - ledger rows:          json.dumps(row, sort_keys=True), one per line
 *  - label history lines:  json.dumps(sort_keys=True), one per line
 *
 * Plain JSON.parse/JSON.stringify break that three ways, all observed on real
 * repos (2026-10-01): a float with an integral value (`30.0`) parses to the JS
 * number 30 and re-serializes as the int `30`; JS float formatting differs from
 * Python repr (`0.00001` vs `1e-05`); non-ASCII is not escaped (Python's
 * ensure_ascii=True). So `loadsPy` keeps every integral-valued or non-finite
 * float as a `PyFloat` box, the dumpers format numbers with Python repr and
 * escape strings like ensure_ascii, and computed floats that may be integral
 * (success_rate, refreshed stats) are wrapped with `pyFloat`.
 *
 * Key order: a plain JS object always enumerates integer-like keys first,
 * ascending, whatever the source order. Callers whose file is written WITHOUT
 * sort_keys and may carry integer-like keys load with `{dictsAsMaps: true}`
 * (Python dict insertion order survives in a Map); `{requireStableKeyOrder:
 * true}` fails loud instead when a plain object would silently reorder.
 */

/** A Python float whose value JS cannot mark as float: integral or non-finite. */
export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
  valueOf(): number {
    return this.value;
  }
  toJSON(): number {
    return this.value;
  }
}

type Json =
  | null
  | boolean
  | number
  | PyFloat
  | string
  | Json[]
  | { [key: string]: Json }
  | Map<string, Json>;

/** A Python float value: boxed when JS would otherwise print it as an int. */
export function pyFloat(value: number): number | PyFloat {
  return Number.isInteger(value) || !Number.isFinite(value) ? new PyFloat(value) : value;
}

/** Numeric value of a parsed number cell (int, float or PyFloat). */
export function num(value: unknown): number {
  if (value instanceof PyFloat) return value.value;
  if (typeof value !== "number") throw new Error(`Expected a number, got ${JSON.stringify(value)}`);
  return value;
}

// ---------------------------------------------------------------- loading

export interface LoadOptions {
  /** Objects become Map<string, Json> (Python dict insertion order). */
  dictsAsMaps?: boolean;
  /** Throw when a plain object's enumeration order differs from the source. */
  requireStableKeyOrder?: boolean;
}

const NUMBER_RE = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

/** json.loads semantics: ints, floats (PyFloat when integral), NaN/Infinity. */
export function loadsPy(text: string, options: LoadOptions = {}): Json {
  let pos = 0;
  const fail = (msg: string): never => {
    throw new Error(`loadsPy: ${msg} at offset ${pos}`);
  };
  const skipWs = () => {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) pos++;
      else break;
    }
  };
  const parseString = (): string => {
    const start = pos;
    pos++; // opening quote
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === 0x5c) pos += 2;
      else if (c === 0x22) {
        pos++;
        // JSON.parse on the exact token: standard escapes, strict control chars.
        return JSON.parse(text.slice(start, pos)) as string;
      } else pos++;
    }
    return fail("unterminated string");
  };
  const parseValue = (): Json => {
    skipWs();
    const c = text[pos];
    if (c === "{") {
      pos++;
      const entries: Array<[string, Json]> = [];
      skipWs();
      if (text[pos] === "}") pos++;
      else {
        for (;;) {
          skipWs();
          if (text[pos] !== '"') fail("expected object key");
          const key = parseString();
          skipWs();
          if (text[pos] !== ":") fail("expected ':'");
          pos++;
          entries.push([key, parseValue()]);
          skipWs();
          if (text[pos] === ",") pos++;
          else if (text[pos] === "}") {
            pos++;
            break;
          } else fail("expected ',' or '}'");
        }
      }
      if (options.dictsAsMaps) return new Map(entries);
      const obj: { [key: string]: Json } = {};
      for (const [k, v] of entries) obj[k] = v; // duplicate key: last wins, like Python
      if (options.requireStableKeyOrder) {
        const sourceOrder = [...new Map(entries).keys()];
        const jsOrder = Object.keys(obj);
        if (sourceOrder.some((k, i) => jsOrder[i] !== k)) {
          fail(`object key order [${sourceOrder.slice(0, 8)}…] would be reordered by JS`);
        }
      }
      return obj;
    }
    if (c === "[") {
      pos++;
      const arr: Json[] = [];
      skipWs();
      if (text[pos] === "]") pos++;
      else {
        for (;;) {
          arr.push(parseValue());
          skipWs();
          if (text[pos] === ",") pos++;
          else if (text[pos] === "]") {
            pos++;
            break;
          } else fail("expected ',' or ']'");
        }
      }
      return arr;
    }
    if (c === '"') return parseString();
    for (const [lit, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
      ["NaN", new PyFloat(NaN)],
      ["Infinity", new PyFloat(Infinity)],
      ["-Infinity", new PyFloat(-Infinity)],
    ] as Array<[string, Json]>) {
      if (text.startsWith(lit, pos)) {
        pos += lit.length;
        return value;
      }
    }
    NUMBER_RE.lastIndex = pos;
    const m = NUMBER_RE.exec(text);
    if (m === null) return fail("unexpected token");
    pos += m[0].length;
    const value = Number(m[0]);
    if (m[1] === undefined && m[2] === undefined) {
      if (!Number.isSafeInteger(value)) {
        fail(`integer ${m[0]} exceeds the float64-exact range; refusing to round it`);
      }
      return value;
    }
    return pyFloat(value);
  };
  const out = parseValue();
  skipWs();
  if (pos !== text.length) fail("trailing data");
  return out;
}

// ---------------------------------------------------------------- dumping

/** Python float.__repr__ (shortest round-trip digits, repr's fixed/exp switch). */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  // toExponential() with no argument = shortest digits that round-trip.
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(x.toExponential());
  if (m === null) throw new Error(`pyFloatRepr: unexpected exponent form for ${x}`);
  const sign = m[1];
  const digits = m[2] + (m[3] ?? "");
  const decpt = parseInt(m[4], 10) + 1; // value = 0.<digits> * 10^decpt
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) return `${sign}0.${"0".repeat(-decpt)}${digits}`;
    if (decpt >= digits.length) return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
    return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  const exp = decpt - 1;
  return `${sign}${mantissa}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

const SHORT_ESCAPES: Record<number, string> = {
  0x22: '\\"',
  0x5c: "\\\\",
  0x0a: "\\n",
  0x0d: "\\r",
  0x09: "\\t",
  0x08: "\\b",
  0x0c: "\\f",
};

/** json.dumps string encoding with ensure_ascii=True. */
export function pyStr(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const short = SHORT_ESCAPES[c];
    if (short !== undefined) out += short;
    else if (c < 0x20 || c > 0x7e) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += s[i];
  }
  return out + '"';
}

function serialize(value: Json, indent: number | null, sortKeys: boolean, depth: number): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof PyFloat) return pyFloatRepr(value.value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot serialize non-finite JS number ${value}; box it with pyFloat`);
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) throw new Error(`Integer ${value} is outside the float64-exact range`);
      return String(Object.is(value, -0) ? 0 : value);
    }
    return pyFloatRepr(value);
  }
  if (typeof value === "string") return pyStr(value);
  const nl = indent !== null ? "\n" + " ".repeat(indent * (depth + 1)) : "";
  const nlEnd = indent !== null ? "\n" + " ".repeat(indent * depth) : "";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => serialize(v, indent, sortKeys, depth + 1));
    return indent !== null ? `[${nl}${items.join("," + nl)}${nlEnd}]` : `[${items.join(", ")}]`;
  }
  const entries: Array<[string, Json]> =
    value instanceof Map ? [...value.entries()] : Object.entries(value as { [key: string]: Json });
  if (sortKeys) entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (entries.length === 0) return "{}";
  const items = entries.map(([k, v]) => `${pyStr(k)}: ${serialize(v, indent, sortKeys, depth + 1)}`);
  return indent !== null ? `{${nl}${items.join("," + nl)}${nlEnd}}` : `{${items.join(", ")}}`;
}

/** json.dumps(value, indent=2) */
export function dumpsIndent2(value: Json): string {
  return serialize(value, 2, false, 0);
}

/** json.dumps(value, indent=2, sort_keys=True) */
export function dumpsIndent2Sorted(value: Json): string {
  return serialize(value, 2, true, 0);
}

/** json.dumps(value, sort_keys=True) — compact with Python default separators. */
export function dumpsSorted(value: Json): string {
  return serialize(value, null, true, 0);
}

/** json.dumps(value, indent=4) — used by meta/stats.json. */
export function dumpsIndent4(value: Json): string {
  return serialize(value, 4, false, 0);
}

export type { Json };
