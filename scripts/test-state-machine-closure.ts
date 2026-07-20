/**
 * 综合测试：验证 Build 及以后阶段的状态机闭环
 *
 * 用户需求验证：
 * 1. 状态机必须闭环，不能有死锁
 * 2. Build/Review 等阶段无条件可重新运行
 * 3. 不允许锁定
 */

import { db } from "../server/db";
import { changes } from "../server/db/schema";
import { eq } from "drizzle-orm";
import { computeActions } from "../server/services/action-contract-service";

const TEST_CHANGE = "CHG-002";

console.log("=".repeat(70));
console.log("状态机闭环验证：Build 及以后阶段");
console.log("=".repeat(70));
console.log();

const change = db.select().from(changes).where(eq(changes.id, TEST_CHANGE)).get();
if (!change) {
  console.error(`Change ${TEST_CHANGE} not found`);
  process.exit(1);
}

// 测试所有关键状态的退出路径
const criticalStates = [
  { status: "PLAN_APPROVED", description: "Plan 已批准，准备 Build" },
  { status: "IMPLEMENTING", description: "正在实施" },
  { status: "IMPLEMENTED", description: "实施完成，准备 Review" },
  { status: "REVIEWING", description: "正在 Review" },
  { status: "BLOCKED", description: "被阻塞" },
  { status: "CHECK_FAILED", description: "QA 失败" },
  { status: "FIXING", description: "正在修复" },
  { status: "MERGE_READY", description: "准备合并" },
];

let allHaveExit = true;
let totalRetryActions = 0;

console.log("检查每个状态的退出路径：\n");

for (const testState of criticalStates) {
  db.update(changes).set({ status: testState.status }).where(eq(changes.id, TEST_CHANGE)).run();

  const actions = computeActions(TEST_CHANGE);
  const enabledActions = actions.filter(a => a.enabled);
  const retryActions = enabledActions.filter(a => a.actionId.startsWith("retry_"));

  console.log(`${testState.status} (${testState.description})`);
  console.log(`  可用操作数: ${enabledActions.length}`);
  console.log(`  其中 retry 操作: ${retryActions.length}`);

  if (retryActions.length > 0) {
    console.log(`  retry 操作列表: ${retryActions.map(a => a.actionId).join(", ")}`);
    totalRetryActions += retryActions.length;
  }

  if (enabledActions.length === 0) {
    console.log(`  ⚠️  警告: 状态 ${testState.status} 没有可用操作，可能是死锁！`);
    allHaveExit = false;
  } else {
    console.log(`  ✅ 有退出路径`);
  }
  console.log();
}

// 恢复原始状态
db.update(changes).set({ status: change.status }).where(eq(changes.id, TEST_CHANGE)).run();

console.log("=".repeat(70));
console.log("验证结果");
console.log("=".repeat(70));
console.log();

if (allHaveExit) {
  console.log("✅ 状态机闭环验证通过：所有状态都有退出路径");
} else {
  console.log("❌ 状态机闭环验证失败：存在死锁状态");
}

console.log(`✅ 总共 ${totalRetryActions} 个 retry 操作在各状态下可用`);

// 特别验证：retry_build 和 retry_review 的可用性
console.log();
console.log("=".repeat(70));
console.log("重点验证：retry_build 和 retry_review 的无条件可用性");
console.log("=".repeat(70));
console.log();

let retryBuildAlwaysAvailable = true;
let retryReviewAlwaysAvailable = true;

for (const testState of criticalStates) {
  db.update(changes).set({ status: testState.status }).where(eq(changes.id, TEST_CHANGE)).run();

  const actions = computeActions(TEST_CHANGE);
  const retryBuild = actions.find(a => a.actionId === "retry_build");
  const retryReview = actions.find(a => a.actionId === "retry_review");

  if (!retryBuild?.enabled) {
    console.log(`❌ ${testState.status}: retry_build 不可用 (${retryBuild?.reasonCode})`);
    retryBuildAlwaysAvailable = false;
  }

  if (!retryReview?.enabled) {
    console.log(`❌ ${testState.status}: retry_review 不可用 (${retryReview?.reasonCode})`);
    retryReviewAlwaysAvailable = false;
  }
}

db.update(changes).set({ status: change.status }).where(eq(changes.id, TEST_CHANGE)).run();

console.log();
if (retryBuildAlwaysAvailable && retryReviewAlwaysAvailable) {
  console.log("✅ retry_build 和 retry_review 在所有状态下都可用");
} else {
  if (!retryBuildAlwaysAvailable) {
    console.log("❌ retry_build 在某些状态下不可用");
  }
  if (!retryReviewAlwaysAvailable) {
    console.log("❌ retry_review 在某些状态下不可用");
  }
}

console.log();
console.log("=".repeat(70));
console.log("测试完成");
console.log("=".repeat(70));

// 退出码：所有检查都通过才返回 0
if (allHaveExit && retryBuildAlwaysAvailable && retryReviewAlwaysAvailable) {
  process.exit(0);
} else {
  process.exit(1);
}
