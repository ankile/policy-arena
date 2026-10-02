/**
 * Python json compatibility of pyjson.ts. Expected strings were produced by
 * CPython 3 (repr / json.dumps); see tests/applyCanonical.test.ts for the
 * apply-level regressions this guards.
 */

import { describe, expect, test } from "bun:test";
import {
  PyFloat,
  dumpsIndent2,
  dumpsIndent4,
  dumpsSorted,
  loadsPy,
  pyFloat,
  pyFloatRepr,
} from "../convex/apply/pyjson";

// [python repr(x), expected pyFloatRepr(float(repr))] — repr round-trips, so
// parsing the repr gives the exact double.
const REPR_CASES: Array<[string, string]> = [
  ["0.0", "0.0"],
  ["-0.0", "-0.0"],
  ["1.0", "1.0"],
  ["30.0", "30.0"],
  ["-1.0", "-1.0"],
  ["0.5", "0.5"],
  ["0.1", "0.1"],
  ["1e-05", "1e-05"],
  ["1.5e-05", "1.5e-05"],
  ["0.0001", "0.0001"],
  ["0.00012345", "0.00012345"],
  ["0.0001", "0.0001"],
  ["1e+16", "1e+16"],
  ["1000000000000000.0", "1000000000000000.0"],
  ["1.2345678901234568e+17", "1.2345678901234568e+17"],
  ["1e+22", "1e+22"],
  ["1.7976931348623157e+308", "1.7976931348623157e+308"],
  ["5e-324", "5e-324"],
  ["2.2250738585072014e-308", "2.2250738585072014e-308"],
  ["0.014466546475887299", "0.014466546475887299"],
  ["-1.000000013351432e-10", "-1.000000013351432e-10"],
  ["0.9998617270588874", "0.9998617270588874"],
  ["0.3333333333333333", "0.3333333333333333"],
  ["0.6666666666666666", "0.6666666666666666"],
  ["100.0", "100.0"],
  ["1234.5", "1234.5"],
  ["-4.944409740515177e-11", "-4.944409740515177e-11"],
  ["9999999999999998.0", "9999999999999998.0"],
  ["0.30000000000000004", "0.30000000000000004"],
  ["688843.7030500963", "688843.7030500963"],
  ["515908.805880605", "515908.805880605"],
  ["-158856.83833831002", "-158856.83833831002"],
  ["-482166.4994140733", "-482166.4994140733"],
  ["22549.44273721706", "22549.44273721706"],
  ["-190131.7250991714", "-190131.7250991714"],
  ["567597.1780695452", "567597.1780695452"],
  ["-393374.5478421451", "-393374.5478421451"],
  ["-46806.09169528843", "-46806.09169528843"],
  ["166764.07891006232", "166764.07891006232"],
  ["816225.7703906703", "816225.7703906703"],
  ["9373.711634780513", "9373.711634780513"],
  ["-436324.3112005923", "-436324.3112005923"],
  ["511608.40831444785", "511608.40831444785"],
  ["236737.99335066322", "236737.99335066322"],
  ["-498987.3172751189", "-498987.3172751189"],
  ["819492.5119364802", "819492.5119364802"],
  ["965570.9520753061", "965570.9520753061"],
  ["620434.4719931791", "620434.4719931791"],
  ["804331.9008791654", "804331.9008791654"],
  ["4.063068639616058e-12", "4.063068639616058e-12"],
  ["61645999099885.055", "61645999099885.055"],
  ["8.517208485085291e+23", "8.517208485085291e+23"],
  ["109404683711.31946", "109404683711.31946"],
  ["0.021308993021427535", "0.021308993021427535"],
  ["1.1017231726903406e-24", "1.1017231726903406e-24"],
  ["0.00011228199674621331", "0.00011228199674621331"],
  ["4500061.059991348", "4500061.059991348"],
  ["6.03480434385299e+24", "6.03480434385299e+24"],
  ["9.917040029650407e+27", "9.917040029650407e+27"],
  ["0.04174328213163281", "0.04174328213163281"],
  ["8.290785254054427e+21", "8.290785254054427e+21"],
  ["4.261265790114822e-15", "4.261265790114822e-15"],
  ["2.002947752700041e+18", "2.002947752700041e+18"],
  ["835.5226549109448", "835.5226549109448"],
  ["6.95828174867825e-30", "6.95828174867825e-30"],
  ["15215323279629.523", "15215323279629.523"],
  ["8.499874891814554e-07", "8.499874891814554e-07"],
  ["3.095270644535874e+19", "3.095270644535874e+19"],
  ["12279822065.020658", "12279822065.020658"],
];

describe("pyFloatRepr", () => {
  test("matches CPython float repr", () => {
    for (const [literal, expected] of REPR_CASES) {
      expect(pyFloatRepr(Number(literal))).toBe(expected);
    }
    expect(pyFloatRepr(NaN)).toBe("NaN");
    expect(pyFloatRepr(-Infinity)).toBe("-Infinity");
  });
});

describe("loadsPy + dumps round-trip CPython json.dumps output byte-for-byte", () => {
  test("sort_keys compact: ensure_ascii, int vs float, NaN/Infinity", () => {
    const text = "{\"10\": 1, \"9\": [], \"a\": \"caf\\u00e9 \\u2014 \\ud83d\\ude00 \\u007f \\u0001 \\\"q\\\" \\\\ /\", \"n\": [1, 2.0, -0.0, NaN, Infinity], \"z\": {}}";
    expect(dumpsSorted(loadsPy(text))).toBe(text);
  });
  test("indent=2 with integer-like keys in insertion order (Map mode)", () => {
    const text = "{\n  \"changed_episodes\": {\n    \"10\": {\n      \"a\": 1.0\n    },\n    \"9\": {\n      \"b\": [\n        1,\n        2\n      ]\n    },\n    \"50\": {}\n  },\n  \"skipped_episodes\": [\n    3,\n    1\n  ]\n}";
    expect(dumpsIndent2(loadsPy(text, { dictsAsMaps: true }))).toBe(text);
  });
  test("indent=4 stats.json", () => {
    const text = "{\n    \"reward\": {\n        \"min\": [\n            0.0\n        ],\n        \"count\": [\n            42199\n        ],\n        \"mean\": [\n            0.005995402578264475\n        ]\n    }\n}";
    expect(dumpsIndent4(loadsPy(text, { requireStableKeyOrder: true }))).toBe(text);
  });
});

describe("loadsPy guards", () => {
  test("integral floats are boxed, ints stay numbers", () => {
    const parsed = loadsPy('{"a": 30.0, "b": 30, "c": 0.5}') as Record<string, unknown>;
    expect(parsed.a).toBeInstanceOf(PyFloat);
    expect(Number(parsed.a)).toBe(30);
    expect(parsed.b).toBe(30);
    expect(parsed.c).toBe(0.5);
    expect(pyFloat(1)).toBeInstanceOf(PyFloat);
    expect(pyFloat(0.25)).toBe(0.25);
  });
  test("a plain object that JS would reorder fails loud when order matters", () => {
    expect(() => loadsPy('{"10": 1, "9": 2}', { requireStableKeyOrder: true })).toThrow(/reordered/);
    expect(() => loadsPy('{"a": 1, "9": 2}', { requireStableKeyOrder: true })).toThrow(/reordered/);
    expect(() => loadsPy('{"9": 1, "10": 2, "a": 3}', { requireStableKeyOrder: true })).not.toThrow();
  });
  test("integers beyond 2^53 are refused, not rounded", () => {
    expect(() => loadsPy("[9007199254740993]")).toThrow(/float64-exact/);
  });
  test("malformed input fails", () => {
    expect(() => loadsPy('{"a": 1,}')).toThrow();
    expect(() => loadsPy("[1] x")).toThrow(/trailing/);
  });
});

describe("ledger repair writes Python _write_jsonl_rows bytes", () => {
  test("json.dumps(row, sort_keys=True) per line, floats and escapes preserved", async () => {
    const { repairLedger } = await import("../convex/apply/ledgers");
    // Input as the collector wrote it (insertion order); expected from CPython.
    const text =
      '{"episode_index": 0, "success": false, "outcome": "failure", "duration_s": 12.0, "note": "caf\\u00e9", "z_rate": 1e-05}\n' +
      '{"episode_index": 1, "success": false, "outcome": "failure", "duration_s": 7.5}\n';
    const out = repairLedger({
      path: "meta/protocol_quota_ledger.jsonl",
      text,
      outcomesByEpisode: new Map([
        [0, "failure"],
        [1, "success"],
      ]),
      onlyEpisodes: new Set([0, 1]),
    });
    expect(out).toBe(
      '{"duration_s": 12.0, "episode_index": 0, "note": "caf\\u00e9", "outcome": "failure", "success": false, "z_rate": 1e-05}\n' +
        '{"duration_s": 7.5, "episode_index": 1, "outcome": "success", "success": true}\n'
    );
  });
});
