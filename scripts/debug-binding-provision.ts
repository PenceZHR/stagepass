/**
 * Reproduces project-PRD binding provisioning with the error printed in full.
 *
 * The pipeline records only `last_error_code = shell_provision_ambiguous` on
 * the binding row, and four distinct failures share that code, so the row alone
 * cannot say which one happened. The reason string only exists in the thrown
 * error and in stdout logs.
 */
import { getProductionCodexDesktopBridge } from "../server/services/codex-desktop-engine.ts";
import { ensureCodexThreadBinding } from "../server/services/codex-thread-binding-service.ts";

const projectId = process.argv[2] ?? "PRJ-001";

async function main() {
  const bridge = await getProductionCodexDesktopBridge();
  console.log("bridge probe:", JSON.stringify(await bridge.probe(), null, 2).slice(0, 400));

  try {
    const binding = await ensureCodexThreadBinding({
      scope: { kind: "project_prd", scopeId: projectId, projectId },
      bridge,
    });
    console.log("\nBINDING OK:", JSON.stringify(binding, null, 2).slice(0, 600));
  } catch (error) {
    console.error("\nPROVISION FAILED");
    console.error("name   :", (error as Error)?.name);
    console.error("code   :", (error as { code?: string })?.code);
    console.error("message:", (error as Error)?.message);
    const cause = (error as { cause?: unknown })?.cause;
    if (cause) console.error("cause  :", String(cause).slice(0, 800));
    console.error((error as Error)?.stack?.split("\n").slice(0, 8).join("\n"));
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error("unexpected:", error);
  process.exit(1);
});
