import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { join } from "node:path";

/**
 * 我们对官方 App Server 协议的全部假设。
 *
 * 交接文档写着「升级 Codex 后先生成并核对官方 App Server schema」—— 那是一句
 * 只能靠人记得的话，仓库里既没有 schema 基线也没有任何检查。Codex 一升级，
 * 方法名或参数改了，症状是真机上某个动作静默失败，而套件全绿。
 *
 * `generate-json-schema` 只导出 schema：不起线程、不跑 turn、不花钱，
 * 所以它不违反「只走面板 TUI」那条规矩。
 */
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  "thread/start": [],
  "thread/resume": ["threadId"],
  "thread/unsubscribe": ["threadId"],
  "thread/read": ["threadId", "includeTurns"],
  "thread/turns/list": ["threadId", "limit", "sortDirection"],
  "thread/archive": ["threadId"],
  "thread/unarchive": ["threadId"],
  "thread/list": [],
  "thread/loaded/list": ["cursor", "limit"],
  "turn/start": ["threadId", "input"],
  "turn/interrupt": ["threadId", "turnId"],
  "turn/steer": ["threadId"],
};

interface JsonSchema {
  readonly definitions?: Record<string, JsonSchema>;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly enum?: readonly string[];
  readonly $ref?: string;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
}

function requestSchema(): JsonSchema | null {
  try {
    execFileSync("/usr/bin/which", ["codex"], { stdio: "pipe" });
  } catch {
    return null;
  }
  const out = mkdtempSync(join(tmpdir(), "stagepass-app-server-schema-"));
  try {
    execFileSync("codex", ["app-server", "generate-json-schema", "--experimental", "--out", out], {
      stdio: "pipe",
    });
  } catch {
    return null;
  }
  if (!readdirSync(out).includes("ClientRequest.json")) return null;
  return JSON.parse(readFileSync(join(out, "ClientRequest.json"), "utf8")) as JsonSchema;
}

/** 找出声明 `method` 为 `name` 的那一支，返回它 params 的属性名。 */
function paramsOf(schema: JsonSchema, name: string): readonly string[] | null {
  const definitions = schema.definitions ?? {};
  const variants = [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])];
  for (const variant of variants) {
    if (variant.properties?.method?.enum?.[0] !== name) continue;
    const ref = variant.properties.params?.$ref;
    if (ref === undefined) return [];
    const target = definitions[ref.split("/").at(-1) ?? ""];
    return Object.keys(target?.properties ?? {});
  }
  return null;
}

describe("App Server protocol contract", () => {
  const schema = requestSchema();

  it("still accepts every method StagePass sends", (t) => {
    if (schema === null) {
      t.skip("这台机器上没有可用的 codex，协议契约未经核对");
      return;
    }
    for (const name of Object.keys(REQUIRED)) {
      assert.notEqual(
        paramsOf(schema, name),
        null,
        `官方 App Server 不再接受 ${name}；升级 Codex 之后协议漂了`,
      );
    }
  });

  it("still accepts every parameter StagePass sends", (t) => {
    if (schema === null) {
      t.skip("这台机器上没有可用的 codex，协议契约未经核对");
      return;
    }
    for (const [name, expected] of Object.entries(REQUIRED)) {
      const actual = paramsOf(schema, name);
      if (actual === null) continue;
      for (const key of expected) {
        assert.ok(actual.includes(key), `${name} 不再接受参数 ${key}（现有：${actual.join(", ")}）`);
      }
    }
  });
});
