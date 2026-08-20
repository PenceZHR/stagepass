import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "./change-store";
import { NoteStore } from "./note-store";
import { ProjectStore } from "./project-store";

const AT = "2026-08-19T10:00:00.000Z";

function setup() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure("PRJ-1", "p", "/tmp/p");
  new ChangeStore(database, { now: () => new Date(AT) })
    .create("CHG-1", { projectId: "PRJ-1" });
  return new NoteStore(database, () => new Date(AT));
}

describe("L1 · 意见和它的下文", () => {
  it("id 由这一侧发，人和模型都不写", () => {
    const notes = setup();
    const one = notes.add({ changeId: "CHG-1", phase: "PRD", sectionKey: "problem", text: "太虚" });
    assert.match(one.id, /^NOTE-\d{4}$/);
    assert.equal(one.response, null);
  });

  it("没下文的进 open，有下文的不进 —— 闸门读的就是它", () => {
    const notes = setup();
    const a = notes.add({ changeId: "CHG-1", phase: "PRD", sectionKey: "problem", text: "太虚" });
    notes.add({ changeId: "CHG-1", phase: "PRD", sectionKey: "outcome", text: "没写数" });
    assert.equal(notes.open("CHG-1", "PRD").length, 2);
    notes.respond(a.id, "改了，第一节现在点了名");
    assert.deepEqual(notes.open("CHG-1", "PRD").map((n) => n.sectionKey), ["outcome"]);
  });

  it("**明说不改也算下文** —— 闸门要的是有交代，不是必须听话", () => {
    const notes = setup();
    const a = notes.add({ changeId: "CHG-1", phase: "PRD", sectionKey: "fixed", text: "加个约束" });
    assert.equal(notes.respond(a.id, "不改：那是 Arch 的事，已写进「留给下游」").ok, true);
    assert.equal(notes.open("CHG-1", "PRD").length, 0);
  });

  it("重答要拒 —— 覆盖会让「他当时怎么答的」凭空消失", () => {
    const notes = setup();
    const a = notes.add({ changeId: "CHG-1", phase: "PRD", sectionKey: "problem", text: "太虚" });
    notes.respond(a.id, "改了");
    const again = notes.respond(a.id, "其实没改");
    assert.equal(again.ok, false);
    assert.match(again.reason!, /再留一条意见/);
    assert.equal(notes.read(a.id)!.response, "改了");
  });

  it("别的阶段的意见不混进来", () => {
    const notes = setup();
    notes.add({ changeId: "CHG-1", phase: "PRD", sectionKey: "problem", text: "PRD 的" });
    notes.add({ changeId: "CHG-1", phase: "Spec", sectionKey: "scope", text: "Spec 的" });
    assert.deepEqual(notes.list("CHG-1", "PRD").map((n) => n.text), ["PRD 的"]);
  });
});
