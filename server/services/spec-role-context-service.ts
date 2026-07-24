export interface SpecCriticContextInput {
  frozenSpecArtifact: string;
  requirements: string;
  checklist: string;
}

export interface SpecCriticContext {
  prompt: string;
  outputArtifactKind: "spec_critic_review";
}

/**
 * Rebuilds the critic's role-scoped input from durable artifacts. Deliberately
 * destructuring only the three admitted fields discards writer scratch,
 * transcript, reasoning, and any future caller-controlled extras.
 */
export function buildSpecCriticContext(
  input: SpecCriticContextInput,
): SpecCriticContext {
  const {
    frozenSpecArtifact,
    requirements,
    checklist,
  } = input;
  const required = [
    ["frozenSpecArtifact", frozenSpecArtifact],
    ["requirements", requirements],
    ["checklist", checklist],
  ] as const;
  for (const [name, value] of required) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Spec critic context is missing ${name}`);
    }
  }
  return {
    prompt: [
      "Perform a fresh adversarial evaluation of the frozen specification.",
      "Do not rely on, repeat, or infer the writer's scratch work or transcript.",
      "",
      "## Frozen specification",
      frozenSpecArtifact,
      "",
      "## Current requirements",
      requirements,
      "",
      "## Versioned review checklist",
      checklist,
    ].join("\n"),
    outputArtifactKind: "spec_critic_review",
  };
}
