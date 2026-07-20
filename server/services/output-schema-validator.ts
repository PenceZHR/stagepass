/**
 * The one JSON-schema check every stage's `outputSchema` runs through.
 *
 * It lived privately inside pipeline-document-stage-runner-service until the
 * refine stage -- a chat turn with no run ledger, so it cannot go through
 * runDocumentStage -- needed the same second gate over its line-protocol
 * payload. Two implementations would have meant two definitions of "valid
 * stage output", so this is a move, not a fork: the logic is byte-for-byte what
 * the document runner has always applied.
 *
 * Deliberately a subset of JSON Schema: `type`, `enum`, `properties`,
 * `required`, `items`, `additionalProperties`. Stage schemas are hand-written
 * and reviewed, so an unsupported keyword is a review problem, not a runtime
 * one -- but note the consequence, that an unrecognised keyword is IGNORED
 * rather than rejected. Do not reach for a keyword this file does not
 * implement and assume it constrains anything.
 */

export type SchemaValidationResult = true | { ok: false; message: string };

export function validateOutputSchema(schema: unknown, value: unknown): SchemaValidationResult {
  const failure = validateSchemaNode(schema, value, "$");
  return failure ? { ok: false, message: failure } : true;
}

function validateSchemaNode(schema: unknown, value: unknown, location: string): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return null;
  }

  const record = schema as {
    type?: string | string[];
    enum?: unknown[];
    properties?: Record<string, unknown>;
    required?: unknown;
    items?: unknown;
    additionalProperties?: unknown;
  };

  if (record.enum && !record.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    return `${location} must be one of the allowed enum values`;
  }

  if (record.type !== undefined && !schemaTypeMatches(record.type, value)) {
    return `${location} must be ${Array.isArray(record.type) ? record.type.join(" or ") : record.type}`;
  }

  if (isPlainObject(value)) {
    const properties = record.properties ?? {};
    const required = Array.isArray(record.required) ? record.required : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) {
        return `${location}.${key} is required`;
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) {
        const failure = validateSchemaNode(childSchema, value[key], `${location}.${key}`);
        if (failure) return failure;
      }
    }
    if (record.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          return `${location}.${key} is not allowed`;
        }
      }
    }
  }

  if (Array.isArray(value) && record.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      const failure = validateSchemaNode(record.items, value[index], `${location}[${index}]`);
      if (failure) return failure;
    }
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function schemaTypeMatches(type: string | string[], value: unknown): boolean {
  const allowed = Array.isArray(type) ? type : [type];
  return allowed.some((item) => {
    if (item === "null") return value === null;
    if (item === "array") return Array.isArray(value);
    if (item === "object") return isPlainObject(value);
    if (item === "integer") return Number.isInteger(value);
    return typeof value === item;
  });
}
