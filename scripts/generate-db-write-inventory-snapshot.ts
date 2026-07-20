import fs from "node:fs";
import path from "node:path";

import {
  computeDbWritePolicyDigest,
  readIndependentDbWritePolicy,
  scanDbWriteInventory,
} from "../server/db/db-write-inventory";

const rootDir = process.cwd();
const result = scanDbWriteInventory(rootDir);
const entries = [...new Map(
  result.writes
    .filter((write) => !write.file.includes(".test.") && !write.file.startsWith("scripts/test-"))
    .map((write) => [
      [write.file, write.symbol, write.nodeKind, write.target ?? ""].join("|"),
      {
        file: write.file,
        symbol: write.symbol,
        nodeKind: write.nodeKind,
        table: write.target,
        owner: write.owner,
        reason: write.reason,
      },
    ]),
).values()].sort((left, right) =>
  left.file.localeCompare(right.file)
  || left.symbol.localeCompare(right.symbol)
  || left.nodeKind.localeCompare(right.nodeKind)
  || (left.table ?? "").localeCompare(right.table ?? "")
);

if (entries.some((entry) => !entry.owner)) {
  throw new Error("Cannot snapshot unowned production DB writes");
}

const policySha256 = computeDbWritePolicyDigest(
  readIndependentDbWritePolicy(rootDir).productionEntries,
);

fs.writeFileSync(
  path.join(rootDir, "server", "db", "db-write-inventory.snapshot.json"),
  `${JSON.stringify({ schemaVersion: 1, policySha256, entries }, null, 2)}\n`,
);
