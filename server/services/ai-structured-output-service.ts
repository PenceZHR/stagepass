export interface StructuredOutputParseResult {
  value?: unknown;
  source?: "json" | "json_block" | "code_block" | "object_slice";
}

function parseJsonCandidate(text: string): StructuredOutputParseResult | null {
  try {
    return { value: JSON.parse(text), source: "json" };
  } catch {
    return null;
  }
}

function parseMatchedJson(text: string, source: StructuredOutputParseResult["source"]): StructuredOutputParseResult | null {
  try {
    return { value: JSON.parse(text.trim()), source };
  } catch {
    const repaired = repairUnescapedStringQuotes(text.trim());
    if (repaired === text.trim()) return null;
    try {
      return { value: JSON.parse(repaired), source };
    } catch {
      return null;
    }
  }
}

function repairUnescapedStringQuotes(text: string): string {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (!inString) {
      repaired += character;
      if (character === '"') inString = true;
      continue;
    }

    if (escaped) {
      repaired += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      repaired += character;
      escaped = true;
      continue;
    }
    if (character !== '"') {
      repaired += character;
      continue;
    }

    let nextIndex = index + 1;
    while (/\s/.test(text[nextIndex] ?? "")) nextIndex += 1;
    const next = text[nextIndex];
    const closesString =
      next === undefined
      || next === ":"
      || next === "}"
      || next === "]"
      || (next === "," && isLikelyJsonValueStart(text, nextIndex + 1));

    if (closesString) {
      repaired += character;
      inString = false;
    } else {
      repaired += "\\\"";
    }
  }

  return repaired;
}

function isLikelyJsonValueStart(text: string, startIndex: number): boolean {
  let index = startIndex;
  while (/\s/.test(text[index] ?? "")) index += 1;
  const next = text[index];
  return next === undefined || next === '"' || next === "{" || next === "["
    || next === "-" || /[0-9tfn]/.test(next ?? "");
}

export function parseStructuredOutputText(text: string | null | undefined): StructuredOutputParseResult {
  if (!text?.trim()) return {};

  const direct = parseJsonCandidate(text);
  if (direct) return direct;

  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/i);
  if (jsonBlockMatch?.[1]) {
    const parsed = parseMatchedJson(jsonBlockMatch[1], "json_block");
    if (parsed) return parsed;
  }

  const codeBlockMatch = text.match(/```\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch?.[1]) {
    const parsed = parseMatchedJson(codeBlockMatch[1], "code_block");
    if (parsed) return parsed;
  }

  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    const parsed = parseMatchedJson(text.slice(objStart, objEnd + 1), "object_slice");
    if (parsed) return parsed;
  }

  return {};
}
