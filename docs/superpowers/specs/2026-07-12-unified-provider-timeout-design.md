# Unified Provider Timeout Design

## Goal

Set the default provider execution timeout for every AI-backed pipeline stage to 30 minutes while preserving explicit environment-variable overrides.

## Behavior

- The shared default provider timeout is `1_800_000ms`.
- Intake, PRD briefing, Spec writer, Spec critic, TechSpec, Plan, TestPlan, Build, Review, Release, Retro, and context initialization use the same default.
- Existing stage-specific environment variables remain supported. A valid positive override wins over the shared default.
- Invalid, zero, negative, unsafe, or out-of-range overrides fall back to 30 minutes.
- The outer document-stage watchdog remains later than the provider timeout by the existing bounded cleanup grace, so provider termination and lifecycle persistence can finish before the stage is declared stuck.
- Timeout classification remains `provider_timeout`; this change does not add retries or idle-timeout semantics.

## Implementation Boundary

- Introduce one shared timeout constant/helper rather than duplicating `1_800_000` across services.
- Route all AI-stage default timeout readers through that shared value.
- Preserve short timeout injection used by tests and acceptance harnesses.
- Do not change non-model command timeouts such as Git probes, process identity probes, health checks, or SQLite busy timeouts.

## Verification

- A failing test first proves the current defaults are not uniformly 30 minutes.
- Unit tests assert every AI stage resolves to `1_800_000ms` without overrides.
- Unit tests assert valid overrides still win and invalid overrides fall back to `1_800_000ms`.
- Tests assert the outer watchdog remains strictly greater than the provider timeout.
- Run the affected pipeline and engine regression tests, then a production build.
- Restart the service from macOS Terminal and verify the worker receives the new configuration.

## Operational Note

This is an absolute wall-clock timeout. A later change may introduce activity-based idle timeouts, but that is intentionally outside this change.
