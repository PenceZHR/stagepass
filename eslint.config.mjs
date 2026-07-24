import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "logs/**",
    "var/**",
    ".pnpm-store/**",
    ".claude/**",
    ".stagepass/**",
    ".agents/**",
    "plugins/**",
    "mcp/dist/**",
    "server/services/__fixtures__/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
