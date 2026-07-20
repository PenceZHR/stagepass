# Repository Migration Baseline And Whitelist

This directory is the migration boundary for small DB repository wrappers.
Its purpose is to prevent the repository migration from turning into a broad
rewrite of services, routes, tests, or domain ownership.

## Goal

Repository extraction should be a narrow persistence boundary, not a behavior
rewrite. Each repository should wrap a small, owned set of DB reads or writes
while preserving the existing service API and user-visible behavior.

The current direct DB imports across `server` and `app` are a legacy baseline.
They are known debt, but this baseline task does not clear that debt. Future
tasks should migrate only the explicitly approved slices below.

## First Wave Allowed Production Migration

Only these production services are approved for the first repository migration
wave:

- `server/services/pipeline-run-ledger-service.ts`
- `server/services/stage-authority-service.ts`

These services own legacy run ledger writes and DB-first stage authority
persistence. They are the safest first targets because their ownership boundary
is already explicit.

## Second Wave After Route Stabilization

After mutating route preflight and action behavior is stabilized, the following
production access may be wrapped:

- `server/services/preflight-service.ts`
- `server/services/action-contract-persistence-service.ts`
- selected `changes` / `projects` lookup in
  `server/services/action-contract-service.ts`

This wave should stay limited to action/preflight persistence and lookup needs.
It must not become a migration of unrelated domain policy reads.

## Allowed To Remain Direct DB For Now

The following direct DB access is explicitly allowed for now:

- `*.test.ts`
- `server/db/*`
- migrations and seed code
- review, spec, plan, testplan, and QA domain services
- low-risk read-only API routes

These areas may still be migrated later, but not as incidental cleanup inside a
repository task owned by another domain.

## Future Repository Principles

New repositories should follow these rules:

- Keep interfaces small and named around the owning service boundary.
- Preserve owner boundaries; do not let one repository write another domain's
  state as a shortcut.
- Do not cross domains to hide state mutations behind a generic DB helper.
- Do not perform schema migration or data shape redesign in a repository task.
- Do not migrate multiple domains in one task.
- Keep service APIs and observable behavior unchanged unless a separate task
  explicitly approves a behavior change.

## Review Checklist

Before adding or expanding a repository, reviewers should confirm:

- The touched production files are listed in the allowed wave above.
- Remaining direct DB imports match the allowed baseline or have a separate
  approved migration task.
- The repository interface is smaller than the service it supports.
- The diff does not contain schema changes, route rewrites, or unrelated domain
  migrations.
