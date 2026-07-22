import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";

import * as schema from "../db/schema.ts";
import { RUN_DELETE_PLAN, RUN_POINTER_CLEARS } from "./run-delete-plan.ts";

interface Edge {
  readonly column: string;
  readonly target: string;
}

/**
 * The foreign-key graph as schema.ts actually declares it, keyed by table and
 * carrying the referencing column so RUN_POINTER_CLEARS can sever one edge
 * without severing every edge between the same two tables. Read from Drizzle's
 * own metadata rather than the source text, so it cannot drift from the
 * migrations.
 */
function foreignKeyGraph(): Map<string, Edge[]> {
  const graph = new Map<string, Edge[]>();
  for (const exported of Object.values(schema)) {
    if (!(exported instanceof SQLiteTable)) continue;
    const config = getTableConfig(exported);
    const edges: Edge[] = [];
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      const target = getTableConfig(reference.foreignTable).name;
      for (const column of reference.columns) edges.push({ column: column.name, target });
    }
    graph.set(config.name, edges);
  }
  return graph;
}

/**
 * Tables carrying a NOT NULL column literally named `run_id` that no foreign
 * key backs. Nothing in the database refuses a delete that strands these rows,
 * so the plan is the only thing standing between a rework and silent orphans --
 * which is exactly why they are derived here rather than trusted to a hand-kept
 * list. Deliberately keyed on the exact name: `latest_run_id` (stage_runs) and
 * `source_build_run_id` (a build label) are not run references.
 */
function unkeyedRunReferences(): Set<string> {
  const tables = new Set<string>();
  for (const exported of Object.values(schema)) {
    if (!(exported instanceof SQLiteTable)) continue;
    const config = getTableConfig(exported);
    const keyed = new Set(
      config.foreignKeys.flatMap((foreignKey) =>
        foreignKey.reference().columns.map((column) => column.name),
      ),
    );
    for (const column of config.columns) {
      if (column.name === "run_id" && column.notNull && !keyed.has(column.name)) {
        tables.add(config.name);
      }
    }
  }
  return tables;
}

/**
 * The graph a run deletion actually faces: the declared one minus the pointer
 * columns the plan sets to NULL first. Severing those edges is what lets
 * `review_state` and `qa_runs` survive a rework -- and it means a table that
 * reaches `runs` *only* through a cleared pointer needs no delete step.
 */
function graphAfterPointerClears(): Map<string, Edge[]> {
  const graph = foreignKeyGraph();
  for (const clear of RUN_POINTER_CLEARS) {
    const edges = graph.get(clear.table);
    assert.ok(edges, `RUN_POINTER_CLEARS names unknown table ${clear.table}`);
    const before = edges.length;
    graph.set(
      clear.table,
      edges.filter((edge) => !(edge.column === clear.column && edge.target === clear.references)),
    );
    assert.equal(
      graph.get(clear.table)!.length,
      before - 1,
      `${clear.table}.${clear.column} -> ${clear.references} is not a foreign key in schema.ts, so ` +
        "clearing it severs nothing -- RUN_POINTER_CLEARS is stale",
    );
  }
  return graph;
}

/** Tables whose rows hang off a run, directly or through a parent that does. */
function runDependentTables(graph: Map<string, Edge[]>): Set<string> {
  const dependent = new Set<string>();

  const reaches = (table: string, visiting: Set<string>): boolean => {
    if (dependent.has(table)) return true;
    if (visiting.has(table)) return false;
    visiting.add(table);
    for (const edge of graph.get(table) ?? []) {
      if (edge.target === "runs" || reaches(edge.target, visiting)) return true;
    }
    return false;
  };

  for (const table of graph.keys()) {
    if (table === "runs") continue;
    if (reaches(table, new Set())) dependent.add(table);
  }
  return dependent;
}

describe("run delete plan", () => {
  it("deletes each table exactly once", () => {
    const tables = RUN_DELETE_PLAN.map((step) => step.table);
    assert.deepEqual(
      tables.filter((table, index) => tables.indexOf(table) !== index),
      [],
      "a table is deleted twice",
    );
  });

  it("covers exactly the tables that outlive no run", () => {
    const dependent = runDependentTables(graphAfterPointerClears());
    for (const table of unkeyedRunReferences()) dependent.add(table);
    dependent.add("runs");

    assert.deepEqual(
      RUN_DELETE_PLAN.map((step) => step.table).sort(),
      [...dependent].sort(),
      "the delete plan drifted from schema.ts: a table that references a run is missing from " +
        "RUN_DELETE_PLAN (its rows would block the delete, or -- if the reference carries no " +
        "foreign key -- would be silently orphaned by it), or the plan deletes a table that no " +
        "longer hangs off a run",
    );
  });

  it("deletes every table before the tables it references", () => {
    const graph = graphAfterPointerClears();
    const position = new Map(RUN_DELETE_PLAN.map((step, index) => [step.table, index]));

    for (const [table, index] of position) {
      for (const edge of graph.get(table) ?? []) {
        if (edge.target === table) continue; // self-reference: no ordering to honour
        const referencedIndex = position.get(edge.target);
        if (referencedIndex === undefined) continue; // parent outlives the run (e.g. changes)
        assert.ok(
          index < referencedIndex,
          `${table}.${edge.column} references ${edge.target}, so it must be deleted first, but the ` +
            `plan deletes ${table} at #${index} and ${edge.target} at #${referencedIndex} -- this ` +
            "raises SQLITE_CONSTRAINT_FOREIGNKEY",
        );
      }
    }
  });

  it("clears a pointer no later than the step that deletes what it points at", () => {
    // The pointer clears all run before the deletes (change-rework-service
    // applies the two lists in that order), which is only safe if no clear
    // depends on a row a delete has already removed. Assert the dependency
    // rather than the execution order, so the guarantee survives a caller that
    // interleaves them.
    const position = new Map(RUN_DELETE_PLAN.map((step, index) => [step.table, index]));
    for (const clear of RUN_POINTER_CLEARS) {
      assert.ok(
        !position.has(clear.table),
        `${clear.table} is both pointer-cleared and deleted; the clear would be a no-op on a row ` +
          "that is about to disappear, so one of the two lists is wrong",
      );
    }
  });
});
