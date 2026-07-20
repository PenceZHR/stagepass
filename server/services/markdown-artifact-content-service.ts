import type { AiRunResult } from "./ai-engine-types";

export function markdownArtifactContentFromResult(
  result: Pick<AiRunResult, "summary" | "structuredOutput">,
): string {
  const structuredOutput = result.structuredOutput;
  if (
    structuredOutput
    && typeof structuredOutput === "object"
    && !Array.isArray(structuredOutput)
    && typeof (structuredOutput as { markdown?: unknown }).markdown === "string"
  ) {
    return (structuredOutput as { markdown: string }).markdown;
  }

  return result.summary;
}
