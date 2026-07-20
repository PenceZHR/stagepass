/**
 * Test: retry_build and retry_review should be ALWAYS available
 *
 * User requirement: Build和Review等阶段要无条件可重新运行，不允许锁定
 */

import { db } from "../server/db";
import { changes } from "../server/db/schema";
import { eq } from "drizzle-orm";
import { computeActions } from "../server/services/action-contract-service";

const TEST_CHANGE = "CHG-002";

console.log("Testing retry_build and retry_review availability across all states...\n");

const change = db.select().from(changes).where(eq(changes.id, TEST_CHANGE)).get();
if (!change) {
  console.error(`Change ${TEST_CHANGE} not found`);
  process.exit(1);
}

console.log(`Current state: ${change.status}\n`);

// Test current state
const actions = computeActions(TEST_CHANGE);
const retryBuild = actions.find(a => a.actionId === "retry_build");
const retryReview = actions.find(a => a.actionId === "retry_review");

console.log("retry_build:");
console.log(`  enabled: ${retryBuild?.enabled}`);
console.log(`  reasonCode: ${retryBuild?.reasonCode}`);
console.log(`  reason: ${retryBuild?.reason}`);

console.log("\nretry_review:");
console.log(`  enabled: ${retryReview?.enabled}`);
console.log(`  reasonCode: ${retryReview?.reasonCode}`);
console.log(`  reason: ${retryReview?.reason}`);

// Test scenarios that should always allow retry
const testStatuses = [
  "PLAN_APPROVED",
  "IMPLEMENTING",
  "IMPLEMENTED",
  "REVIEWING",
  "BLOCKED",
  "CHECK_FAILED",
  "FIXING",
];

console.log("\n\nTesting retry availability across different statuses:");
console.log("=========================================================\n");

for (const status of testStatuses) {
  // Temporarily set status
  db.update(changes).set({ status }).where(eq(changes.id, TEST_CHANGE)).run();

  const actions = computeActions(TEST_CHANGE);
  const retryBuild = actions.find(a => a.actionId === "retry_build");
  const retryReview = actions.find(a => a.actionId === "retry_review");

  console.log(`Status: ${status}`);
  console.log(`  retry_build: ${retryBuild?.enabled ? "✅ enabled" : "❌ BLOCKED"} ${retryBuild?.enabled ? "" : `(${retryBuild?.reasonCode})`}`);
  console.log(`  retry_review: ${retryReview?.enabled ? "✅ enabled" : "❌ BLOCKED"} ${retryReview?.enabled ? "" : `(${retryReview?.reasonCode})`}`);

  if (!retryBuild?.enabled || !retryReview?.enabled) {
    console.log(`  ⚠️  PROBLEM: Retry actions should ALWAYS be available!`);
  }
  console.log();
}

// Restore original status
db.update(changes).set({ status: change.status }).where(eq(changes.id, TEST_CHANGE)).run();

console.log("\n✅ Test complete");
