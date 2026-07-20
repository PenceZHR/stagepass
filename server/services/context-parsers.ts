const MAX_SELECTED_FILES = 20;
const DOC_TAGS = ["architecture", "coding-rules", "tech-stack", "file-guide"];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseDocBlock(output: string, tag: string): string | null {
  const xmlMatch = output.match(
    new RegExp(`<${escapeRegex(tag)}>\\s*([\\s\\S]*?)\\s*</${escapeRegex(tag)}>`)
  );
  if (xmlMatch) {
    return xmlMatch[1].trim();
  }

  const startMarker = "```" + tag + "\n";
  const startIdx = output.indexOf(startMarker);
  if (startIdx === -1) return null;

  const contentStart = startIdx + startMarker.length;

  let searchFrom = contentStart;
  while (searchFrom < output.length) {
    const closeIdx = output.indexOf("\n```", searchFrom);
    if (closeIdx === -1) return output.slice(contentStart).trim();

    const afterClose = output.slice(closeIdx + 4);
    const afterCloseTrimmed = afterClose.trimStart();
    if (afterCloseTrimmed === "") {
      return output.slice(contentStart, closeIdx).trim();
    }

    const isNextBlock = DOC_TAGS.some(t => afterCloseTrimmed.startsWith("```" + t + "\n"));
    if (isNextBlock) {
      return output.slice(contentStart, closeIdx).trim();
    }

    searchFrom = closeIdx + 4;
  }

  return output.slice(contentStart).trim();
}

export function parseFileSelectionJson(output: string): string[] {
  const jsonBlockMatch = output.match(/```json\s*([\s\S]*?)```/);
  const toParse = jsonBlockMatch ? jsonBlockMatch[1].trim() : output.trim();
  try {
    const parsed = JSON.parse(toParse);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === "string")) {
      return parsed.slice(0, MAX_SELECTED_FILES);
    }
  } catch {
    // fallback
  }

  const arrayMatch = toParse.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return parsed.slice(0, MAX_SELECTED_FILES);
    } catch {
      // fallback
    }
  }

  return [];
}
