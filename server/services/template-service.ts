import fs from "fs";
import path from "path";
import { createChildLogger } from "../logger";

const log = createChildLogger("template-service");

const TEMPLATES_DIR = path.join(process.cwd(), "server", "templates");

export function scaffoldShipDir(repoPath: string): void {
  const shipDir = path.join(repoPath, ".ship");
  fs.mkdirSync(shipDir, { recursive: true });
  fs.mkdirSync(path.join(shipDir, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(shipDir, "changes"), { recursive: true });

  const filesToCopy = [
    "policy.json",
    "architecture.md",
    "coding-rules.md",
    "tech-stack.md",
    "file-guide.md",
    "prompts/plan.md",
    "prompts/implement.md",
    "prompts/fix.md",
    "prompts/refine.md",
    "prompts/prd.md",
    "prompts/init-context.md",
  ];

  for (const file of filesToCopy) {
    const src = path.join(TEMPLATES_DIR, file);
    const dest = path.join(shipDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }

  log.info({ repoPath }, ".ship/ scaffolded from templates");
}
