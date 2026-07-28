# Codex-native Stage UI Design

## Goal

Keep StagePass as a three-column workflow navigator while making Codex App the
only place where stage work, choices, revisions, approvals, and recovery actions
happen.

## Boundary

StagePass Web keeps:

- project/change navigation;
- the stage orbit and current/selected stage state;
- factual blockers;
- read-only artifacts, runs, and events;
- one bridge action: start the selected stage in Codex or open its bound task.

StagePass Web removes:

- PRD questioning and editing;
- Spec/TechSpec battle controls;
- Plan/TestPlan generation and review controls;
- Build/Fix workspace and Git operations;
- Review, QA, Merge, Retro, and Delivery execution controls;
- rubric editing;
- model/reasoning settings, retry, interrupt, repair, and emergency decision forms.

## Stage Detail

Every stage uses the same compact detail surface:

1. stage name, description, and status;
2. factual blocker list, when present;
3. a short statement that work continues in the bound Codex task;
4. collapsed read-only evidence.

The shared Codex control above the stage surface owns the only primary action.
It renders “开始本阶段” when no task is bound and “打开 Codex” (or the
running/selection variant) when a task exists.

## Data Flow

Starting a stage keeps using the existing pipeline action endpoint so the
backend creates or reuses a visible Codex task. From that point, model
questions, checkbox cards, edits, decisions, and continuation turns stay in the
same Codex task. The Web page refreshes projections and displays results only.

## All-stage clarification contract

Every canonical stage (`PRD`, `Spec`, `Tech Spec`, `Plan`, `Test Plan`,
`Build`, `Review`, `Fix`, `QA`, `Merge`, `Retro`, and `Done`) shares one
clarification protocol:

1. Before producing the stage result, Codex identifies only unresolved
   decisions that block correct execution.
2. Codex presents 1–10 concrete questions in one StagePass card batch. Each
   question has its own A/B/C-style options and stable machine identifiers.
3. The user must answer every question in the batch.
4. StagePass records an exact question-to-answer mapping and sends it back to a
   new turn in the same visible Codex task.
5. Codex summarizes the decisions, reassesses the stage, and opens another
   batch when blockers remain.
6. Codex emits the formal stage result only when no execution blocker remains.

A shared policy registry is the source of truth for stage identity, stage
objective, representative concrete questions, and the no-blocker completion
rule. The backend uses it when building Codex run context; the Web stage view
uses the same registry for concise explanatory copy. The examples guide
question specificity but are not a fixed questionnaire.

| Stage | Decisions that may block execution |
| --- | --- |
| PRD | target user, concrete outcome, in/out scope, observable acceptance |
| Spec | exact behavior, edge cases, data/error behavior, compatibility |
| Tech Spec | interface, persistence, concurrency, migration, security boundary |
| Plan | sequencing, ownership, rollback, required verification |
| Test Plan | critical paths, environment, fixtures, pass/fail criteria |
| Build | implementation trade-offs that cannot be resolved from approved artifacts |
| Review | finding severity, required remediation, explicit waiver |
| Fix | remediation choice, compatibility constraint, regression boundary |
| QA | environment, test scope, residual-risk decision |
| Merge | merge/release strategy, rollout, rollback authorization |
| Retro | action owner, follow-up scope, due condition |
| Done | run instructions, delivered scope, known limitations |

The Web page does not render these questions. It states that the selected stage
uses iterative Codex question batches, reports whether Codex is running or
waiting for answers, and provides only the start/open bridge.

## Error Handling

Connection and execution errors remain visible as status text. The Web page
does not offer a second implementation of retry or decisions; recovery is
performed in Codex. Read-only evidence remains available for diagnosis.

## Verification

- source tests prove specialized stage workspaces and Web decision controls are
  no longer mounted;
- component tests prove only start/open bridge actions remain;
- typecheck, lint, and production build pass;
- browser inspection confirms the three-column shell is unchanged and stage
  detail contains no duplicate work controls.
