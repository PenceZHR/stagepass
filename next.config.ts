import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.STAGEPASS_NEXT_DIST_DIR || ".next",
  // The health/recovery routes legitimately read files at runtime (logs dir,
  // supervisor-health.json, DB path) via process.cwd()-rooted paths. Turbopack's
  // file tracer over-traces from those into project-root files like next.config.ts.
  // We run via `next start` (not standalone), so the NFT output isn't used at
  // runtime — exclude the root config from the trace to keep the build warning-free.
  outputFileTracingExcludes: {
    "*": ["./next.config.ts"],
  },
};

export default nextConfig;
