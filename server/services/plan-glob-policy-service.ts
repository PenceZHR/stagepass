import path from "path";

export function normalizeRepoPath(filePath: string): string {
  return path.posix.normalize(filePath.replace(/\\/g, "/")).replace(/^\.\//, "");
}

export function matchesPattern(filePath: string, pattern: string): boolean {
  return pathGlobsOverlap(filePath, pattern);
}

export function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(filePath, pattern));
}

export function segmentGlobsOverlap(left: string, right: string): boolean {
  const visited = new Set<string>();
  const stack: Array<[number, number]> = [[0, 0]];

  while (stack.length > 0) {
    const [leftIndex, rightIndex] = stack.pop() as [number, number];
    const key = `${leftIndex}:${rightIndex}`;
    if (visited.has(key)) continue;
    visited.add(key);

    if (leftIndex === left.length && rightIndex === right.length) {
      return true;
    }

    const leftChar = left[leftIndex];
    const rightChar = right[rightIndex];

    if (leftChar === "*") {
      stack.push([leftIndex + 1, rightIndex]);
    }
    if (rightChar === "*") {
      stack.push([leftIndex, rightIndex + 1]);
    }

    const leftCanConsume = leftIndex < left.length;
    const rightCanConsume = rightIndex < right.length;
    if (!leftCanConsume || !rightCanConsume) continue;

    const consumesOverlap = leftChar === "*" || rightChar === "*" || leftChar === rightChar;
    if (!consumesOverlap) continue;

    stack.push([
      leftChar === "*" ? leftIndex : leftIndex + 1,
      rightChar === "*" ? rightIndex : rightIndex + 1,
    ]);
  }

  return false;
}

export function pathGlobsOverlap(left: string, right: string): boolean {
  const leftParts = normalizeRepoPath(left).split("/");
  const rightParts = normalizeRepoPath(right).split("/");
  const visited = new Set<string>();

  function visit(leftIndex: number, rightIndex: number): boolean {
    const key = `${leftIndex}:${rightIndex}`;
    if (visited.has(key)) return false;
    visited.add(key);

    if (leftIndex === leftParts.length && rightIndex === rightParts.length) {
      return true;
    }

    const leftPart = leftParts[leftIndex];
    const rightPart = rightParts[rightIndex];

    if (leftPart === "**") {
      if (visit(leftIndex + 1, rightIndex)) return true;
      if (rightIndex < rightParts.length && visit(leftIndex, rightIndex + 1)) return true;
      return false;
    }

    if (rightPart === "**") {
      if (visit(leftIndex, rightIndex + 1)) return true;
      if (leftIndex < leftParts.length && visit(leftIndex + 1, rightIndex)) return true;
      return false;
    }

    if (leftIndex >= leftParts.length || rightIndex >= rightParts.length) {
      return false;
    }

    return segmentGlobsOverlap(leftPart, rightPart) && visit(leftIndex + 1, rightIndex + 1);
  }

  return visit(0, 0);
}

export function patternsOverlap(left: string, right: string): boolean {
  return pathGlobsOverlap(left, right);
}

export function isUnsafePlanPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath) || normalized.startsWith("/")) {
    return true;
  }
  return normalized.split("/").some((part) => part === "..");
}
