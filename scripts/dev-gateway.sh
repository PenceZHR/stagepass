#!/bin/sh
# Dev server with turns routed through the app-server gateway.
#
# The variables live in a script rather than on a command line because one of
# them contains a space: `CODEX_INTERNAL_ORIGINATOR_OVERRIDE="Codex Desktop"`
# collapsing to `Codex` is enough to fail the shell-control runtime allowlist,
# and the resulting error talks about missing protocol capabilities rather than
# about the originator -- so the mistake is expensive to find and trivial to
# make when quoting has to survive an extra shell.
set -eu

cd "$(dirname "$0")/.."

export TERM=dumb
export CODEX_INTERNAL_ORIGINATOR_OVERRIDE="Codex Desktop"
export STAGEPASS_CODEX_TURN_TRANSPORT=gateway
export STAGEPASS_DB_PATH="${STAGEPASS_DB_PATH:-/private/tmp/stagepass-gateway-e2e/ship.db}"
export STAGEPASS_CODEX_DESKTOP_BRIDGE=on
export STAGEPASS_MCP_INTERACTIONS=on
export STAGEPASS_CODEX_DECISION_SURFACE=on
export STAGEPASS_CODEX_DECISION_PHASES=PRD,Intake,Spec,TechSpec,Plan,TestPlan,Build,Fix,Review,QA,Merge

mkdir -p "$(dirname "$STAGEPASS_DB_PATH")"

echo "turn transport : $STAGEPASS_CODEX_TURN_TRANSPORT"
echo "originator     : $CODEX_INTERNAL_ORIGINATOR_OVERRIDE"
echo "database       : $STAGEPASS_DB_PATH"

exec pnpm dev
