"use node";

/**
 * Parquet read/write for LeRobot dataset files via parquet-wasm + apache-arrow.
 *
 * Node-runtime only ("use node" actions and tests) — never import from Convex
 * default-runtime functions. Round-trip fidelity was verified against pyarrow
 * (schema equality incl. the huggingface metadata key, bit-exact values) on
 * real LeRobot data + meta/episodes files, 2026-08-21.
 */

import { readParquet, writeParquet, WriterPropertiesBuilder, Compression, Table as WasmTable } from "parquet-wasm";
import {
  Table,
  RecordBatch,
  tableFromIPC,
  tableToIPC,
  makeVector,
  makeBuilder,
  makeData,
  Data,
  Struct,
  Field,
  Type,
} from "apache-arrow";
import type { FileFrameColumns } from "./frames";

export function readArrowTable(buf: Uint8Array): Table {
  // Files may carry several record batches (LeRobot appends meta/episodes in
  // per-session row groups); all rebuilds below are batch-aligned.
  return tableFromIPC(readParquet(buf).intoIPCStream());
}

export function writeArrowTable(table: Table): Uint8Array {
  const props = new WriterPropertiesBuilder().setCompression(Compression.SNAPPY).build();
  return writeParquet(WasmTable.fromIPCStream(tableToIPC(table, "stream")), props);
}

function columnAsFloat64(table: Table, name: string, path: string): Float64Array {
  const col = table.getChild(name);
  if (!col) throw new Error(`${path}: missing required column ${name}`);
  const out = new Float64Array(table.numRows);
  const raw = col.toArray() as ArrayLike<number | bigint>;
  for (let i = 0; i < table.numRows; i++) out[i] = Number(raw[i]);
  return out;
}

/** Extract the scalar edit columns from one data-file table. */
export function extractFrameColumns(path: string, table: Table): FileFrameColumns {
  const rewardCol = table.getChild("reward");
  if (!rewardCol) throw new Error(`${path}: missing required column reward`);
  if (rewardCol.type.typeId !== Type.Float) {
    throw new Error(`${path}: reward column is not a float type`);
  }
  const hasIsValid = table.schema.fields.some((f) => f.name === "is_valid");
  return {
    path,
    numRows: table.numRows,
    episodeIndex: columnAsFloat64(table, "episode_index", path),
    frameIndex: columnAsFloat64(table, "frame_index", path),
    reward: Float32Array.from(rewardCol.toArray() as ArrayLike<number>),
    done: columnAsFloat64(table, "done", path),
    success: columnAsFloat64(table, "success", path),
    isValid: hasIsValid ? columnAsFloat64(table, "is_valid", path) : null,
    dirty: false,
  };
}

function int64Data(values: Float64Array, field: Field): Data {
  const big = new BigInt64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (!Number.isInteger(values[i])) throw new Error(`Non-integer int64 value ${values[i]}`);
    big[i] = BigInt(values[i]);
  }
  return makeVector({ data: big, type: field.type }).data[0];
}

/** Rebuild a table batch-by-batch with per-field replacement Data providers.
 * Reuses the ORIGINAL schema object, so field types, nullability, and the
 * huggingface pandas metadata are preserved exactly. */
function rebuildTable(
  table: Table,
  makeReplacement: (fieldName: string, batchStart: number, batchLength: number, batchIndex: number) => Data | null
): Table {
  const schema = table.schema;
  const batches: RecordBatch[] = [];
  let offset = 0;
  for (let b = 0; b < table.batches.length; b++) {
    const batch = table.batches[b];
    const n = batch.numRows;
    const children: Data[] = schema.fields.map((field) => {
      const replacement = makeReplacement(field.name, offset, n, b);
      if (replacement !== null) {
        if (replacement.length !== n) {
          throw new Error(
            `${field.name}: replacement batch length ${replacement.length} != ${n}`
          );
        }
        return replacement;
      }
      const child = batch.getChild(field.name);
      if (!child) throw new Error(`missing column ${field.name} in batch ${b}`);
      if (child.data.length !== 1) {
        throw new Error(`${field.name}: batch child has ${child.data.length} data chunks`);
      }
      return child.data[0];
    });
    const structData = makeData({
      type: new Struct(schema.fields),
      length: n,
      nullCount: 0,
      children,
    });
    batches.push(new RecordBatch(schema, structData));
    offset += n;
  }
  return new Table(schema, batches);
}

/** Rebuild a data-file table with the edited columns swapped in. */
export function replaceEditColumns(table: Table, cols: FileFrameColumns): Table {
  const fieldByName = new Map(table.schema.fields.map((f) => [f.name, f]));
  return rebuildTable(table, (name, start, length) => {
    if (name === "reward") {
      return makeVector({ data: cols.reward.slice(start, start + length), type: fieldByName.get(name)!.type }).data[0];
    }
    if (name === "done") return int64Data(cols.done.slice(start, start + length), fieldByName.get(name)!);
    if (name === "success") return int64Data(cols.success.slice(start, start + length), fieldByName.get(name)!);
    if (name === "is_valid" && cols.isValid !== null) {
      return int64Data(cols.isValid.slice(start, start + length), fieldByName.get(name)!);
    }
    return null;
  });
}

/**
 * Rebuild selected list-typed cells of a table (meta/episodes stats patch).
 * `patches` maps column name → (rowPos → new cell values). Unpatched rows keep
 * their original cells; the column's arrow type (list<double> / list<int64>)
 * is preserved from the original field.
 */
export function patchListColumns(
  table: Table,
  patches: Map<string, Map<number, number[]>>
): Table {
  for (const name of patches.keys()) {
    const field = table.schema.fields.find((f) => f.name === name);
    if (!field) throw new Error(`missing column ${name}`);
    if (field.type.typeId !== Type.List) {
      throw new Error(`${name}: expected a list column for stats patch, got ${field.type}`);
    }
  }
  return rebuildTable(table, (name, start, length, batchIndex) => {
    const patch = patches.get(name);
    if (!patch) return null;
    const field = table.schema.fields.find((f) => f.name === name)!;
    const childType = (field.type.children as Field[])[0].type;
    const isInt = childType.typeId === Type.Int;
    const builder = makeBuilder({ type: field.type, nullValues: [null] });
    const original = table.batches[batchIndex].getChild(name)!;
    for (let i = 0; i < length; i++) {
      const cell = patch.get(start + i);
      if (cell !== undefined) {
        builder.append(isInt ? (cell.map((v) => BigInt(v)) as unknown as number[]) : cell);
      } else {
        const orig = original.get(i);
        if (orig === null) throw new Error(`${name}: unexpected null cell at row ${start + i}`);
        builder.append(orig.toArray());
      }
    }
    return builder.finish().toVector().data[0];
  });
}

/** Column of numbers from a possibly-bigint arrow column (meta reads). */
export function numberColumn(table: Table, name: string): number[] {
  const col = table.getChild(name);
  if (!col) throw new Error(`missing column ${name}`);
  const out: number[] = [];
  for (let i = 0; i < table.numRows; i++) out.push(Number(col.get(i)));
  return out;
}

/** List-of-strings column (meta/episodes `tasks`, meta/tasks task names). */
export function stringListColumn(table: Table, name: string): string[][] {
  const col = table.getChild(name);
  if (!col) throw new Error(`missing column ${name}`);
  const out: string[][] = [];
  for (let i = 0; i < table.numRows; i++) {
    const cell = col.get(i);
    if (cell === null) throw new Error(`${name}: null cell at row ${i}`);
    out.push([...cell].map((v: unknown) => String(v)));
  }
  return out;
}

export function stringColumn(table: Table, name: string): string[] {
  const col = table.getChild(name);
  if (!col) throw new Error(`missing column ${name}`);
  const out: string[] = [];
  for (let i = 0; i < table.numRows; i++) out.push(String(col.get(i)));
  return out;
}

/** Read one list<float64-or-int64> cell as numbers. */
export function listCell(table: Table, name: string, row: number): number[] {
  const col = table.getChild(name);
  if (!col) throw new Error(`missing column ${name}`);
  const cell = col.get(row);
  if (cell === null) throw new Error(`${name}: null cell at row ${row}`);
  return [...cell].map((v: unknown) => Number(v));
}
