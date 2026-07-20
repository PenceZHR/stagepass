import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_AI_PROVIDER_TIMEOUT_MS,
  MAX_NODE_TIMER_DELAY_MS,
  resolveAiProviderTimeoutMs,
} from "./ai-timeout-policy";

const ENV_NAME = "STAGEPASS_TIMEOUT_POLICY_TEST_MS";
const previous = process.env[ENV_NAME];

afterEach(() => {
  if (previous === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = previous;
});

describe("AI timeout policy", () => {
  it("defaults to thirty minutes", () => {
    delete process.env[ENV_NAME];
    assert.equal(DEFAULT_AI_PROVIDER_TIMEOUT_MS, 1_800_000);
    assert.equal(resolveAiProviderTimeoutMs(ENV_NAME), 1_800_000);
  });

  it("allows a valid positive Node timer override", () => {
    process.env[ENV_NAME] = "123456";
    assert.equal(resolveAiProviderTimeoutMs(ENV_NAME), 123_456);
  });

  for (const invalid of [
    "30abc", "1.5", "+30", "-30", " 30", "30 ", "0", "00",
    String(Number.MAX_SAFE_INTEGER + 1),
    String(MAX_NODE_TIMER_DELAY_MS + 1),
  ]) {
    it(`falls back for invalid override ${JSON.stringify(invalid)}`, () => {
      process.env[ENV_NAME] = invalid;
      assert.equal(resolveAiProviderTimeoutMs(ENV_NAME), 1_800_000);
    });
  }
});
