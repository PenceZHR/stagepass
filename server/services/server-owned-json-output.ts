import { validateOutputSchema } from "./output-schema-validator";

/**
 * Reads a reply that is supposed to BE one JSON document written against a
 * schema the server owns.
 *
 * ## What the rule actually is
 *
 * Not "the model may not emit JSON" -- it may. The rule is that **the model
 * never invents the structure**: the server writes the schema, the model only
 * fills it in. Two paths satisfy that, and this module is the second gate on
 * both:
 *
 *   - the judge's root turn carries `TurnStartParams.outputSchema`, so the
 *     runtime enforces the shape before the server ever sees it;
 *   - a sub-agent cannot be given a schema -- `spawn_agent` has no
 *     `output_schema` parameter (docs/CODEX-SUBAGENT-RUNTIME-EVIDENCE-2026-07-27.md
 *     §2) -- so its schema travels in the prompt and THIS is the only
 *     enforcement it gets.
 *
 * Both paths validate against the same schema object, so the weaker path is not
 * a weaker guarantee: it is the same guarantee, applied later.
 *
 * ## Why reading is deliberately strict
 *
 * No repair, no "find the JSON somewhere in the prose", no taking the largest
 * balanced-brace substring. Those recover a document the model composed on its
 * own terms, which is exactly what the rule forbids -- and they recover it
 * silently, so a side that ignored its schema still settles the round. A reply
 * that is not one JSON document is a protocol violation, and a protocol
 * violation rejects the whole round.
 *
 * A single ``` fence is tolerated because it is a formatting habit rather than
 * a structural choice; it changes nothing about who authored the structure.
 */

export type ServerOwnedJsonFailure =
  | { code: "empty_reply" }
  | { code: "not_json"; detail: string }
  | { code: "not_an_object" }
  | { code: "trailing_content" }
  | { code: "schema_violation"; detail: string };

export type ServerOwnedJsonResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; failure: ServerOwnedJsonFailure };

/**
 * Strips at most one fenced code block wrapping the WHOLE reply.
 *
 * Anchored at both ends on purpose: a fence in the middle of prose means the
 * reply is prose with a JSON illustration in it, not a JSON document, and that
 * has to stay a violation.
 */
function unwrapSingleFence(text: string): string {
  const fenced = /^```(?:json|jsonc)?\s*\n([\s\S]*?)\n?```$/.exec(text.trim());
  return fenced ? fenced[1]!.trim() : text.trim();
}

export function readServerOwnedJson(
  rawText: string | undefined | null,
  schema: Record<string, unknown>,
): ServerOwnedJsonResult {
  const text = unwrapSingleFence(rawText ?? "");
  if (text.length === 0) return { ok: false, failure: { code: "empty_reply" } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // A reply with commentary around a valid object lands here, and it must:
    // the commentary is the model deciding what the reply contains.
    return {
      ok: false,
      failure: {
        code: text.includes("{") ? "trailing_content" : "not_json",
        detail: error instanceof Error ? error.message : String(error),
      } as ServerOwnedJsonFailure,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, failure: { code: "not_an_object" } };
  }

  const validation = validateOutputSchema(schema, parsed);
  if (validation !== true) {
    return { ok: false, failure: { code: "schema_violation", detail: validation.message } };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Operator-facing one-liner. Kept next to the codes so they cannot drift. */
export function describeServerOwnedJsonFailure(failure: ServerOwnedJsonFailure): string {
  switch (failure.code) {
    case "empty_reply":
      return "reply was empty";
    case "not_json":
      return `reply was not JSON: ${failure.detail}`;
    case "trailing_content":
      return "reply was not a single JSON document (extra content around it)";
    case "not_an_object":
      return "reply was JSON but not an object";
    case "schema_violation":
      return `reply did not match the server-owned schema: ${failure.detail}`;
  }
}
