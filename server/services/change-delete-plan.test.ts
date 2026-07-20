import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";

import * as schema from "../db/schema.ts";
import { CHANGE_DELETE_PLAN } from "./change-delete-plan.ts";

/**
 * The foreign-key graph as schema.ts actually declares it: table -> the tables
 * it references. Read from Drizzle's own metadata rather than the source text,
 * so it cannot drift from the migrations.
 */
function foreignKeyGraph(): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const exported of Object.values(schema)) {
    if (!(exported instanceof SQLiteTable)) continue;
    const config = getTableConfig(exported);
    const referenced = new Set<string>();
    for (const foreignKey of config.foreignKeys) {
      referenced.add(getTableConfig(foreignKey.reference().foreignTable).name);
    }
    graph.set(config.name, referenced);
  }
  return graph;
}

/** Tables whose rows hang off a change, directly or through a parent that does. */
function changeDependentTables(graph: Map<string, Set<string>>): Set<string> {
  const dependent = new Set<string>();

  const reaches = (table: string, visiting: Set<string>): boolean => {
    if (dependent.has(table)) return true;
    if (visiting.has(table)) return false;
    visiting.add(table);
    for (const referenced of graph.get(table) ?? []) {
      if (referenced === "changes" || reaches(referenced, visiting)) return true;
    }
    return false;
  };

  for (const table of graph.keys()) {
    if (table === "changes") continue;
    if (reaches(table, new Set())) dependent.add(table);
  }
  return dependent;
}

describe("change delete plan", () => {
  it("deletes each table exactly once", () => {
    const tables = CHANGE_DELETE_PLAN.map((step) => step.table);
    assert.deepEqual(
      tables.filter((table, index) => tables.indexOf(table) !== index),
      [],
      "a table is deleted twice",
    );
  });

  it("covers exactly the tables that reference a change", () => {
    const graph = foreignKeyGraph();
    const dependent = [...changeDependentTables(graph)].sort();
    const planned = CHANGE_DELETE_PLAN.map((step) => step.table).sort();

    assert.deepEqual(
      planned,
      dependent,
      "the delete plan drifted from schema.ts: a table that references a change is missing from " +
        "CHANGE_DELETE_PLAN (its rows would block the delete), or the plan deletes a table that no " +
        "longer hangs off a change",
    );
  });

  it("deletes every table before the tables it references", () => {
    const graph = foreignKeyGraph();
    const position = new Map(CHANGE_DELETE_PLAN.map((step, index) => [step.table, index]));

    for (const [table, index] of position) {
      for (const referenced of graph.get(table) ?? []) {
        if (referenced === table) continue; // self-reference: no ordering to honour
        const referencedIndex = position.get(referenced);
        if (referencedIndex === undefined) continue; // parent outlives the change (e.g. projects)
        assert.ok(
          index < referencedIndex,
          `${table} references ${referenced}, so it must be deleted first, but the plan deletes ` +
            `${table} at #${index} and ${referenced} at #${referencedIndex} -- this raises ` +
            "SQLITE_CONSTRAINT_FOREIGNKEY",
        );
      }
    }
  });
});
