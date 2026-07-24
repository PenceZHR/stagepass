import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { buildGitServiceConsumerInventory } from "./git-service-consumer-inventory.ts";

describe("git-service consumer inventory", () => {
  it("has no production or test consumer after deletion", () => {
    const inventory = buildGitServiceConsumerInventory(path.resolve(process.cwd()));
    assert.deepEqual(inventory.unclassified, []);
    assert.deepEqual(inventory.activeLegacyConsumers, []);
    assert.deepEqual(inventory.productionConsumers.sort(), [
      "server/services/build-workspace-service.ts",
      "server/services/change-service.ts",
      "server/services/merge-readiness-service.ts",
      "server/services/pipeline-build-stage-service.ts",
      "server/services/project-git-state-service.ts",
      "server/services/scope-check-service.ts",
    ]);
  });
});
