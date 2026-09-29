# Engine session semantics

## Goal

Integrate v1.3.9 session semantics into the generic training engine so every
consumer receives one canonical prescription without retaining a second,
legacy progression decision path.

## Upstream reference

Semantics are those of DuarteSantos8/openGym v1.3.9 (tag `e6c920e`, released
2026-09-28; this branch is based on its release commit `9753679`). They were
introduced on `main` without pull requests, for issues #216 and #275:

- `ab0c586` — one progression track per routine occurrence (#216).
- `af916e0` — planned sessions open at the routine's sets and reps (#275).
- `c86add5` — an edited routine restarts from its new sets and reps (#275).
- `a1fb8c4`, `b7834ef`, `bf0f4fd` — the workout card shows the plan, a
  mid-session settings save without a change keeps the progression, a
  hand-excluded exercise keeps today's prescription.

This work targets issue #186, milestone v1.3.12 — Progression engine I.

## Constraints

- Keep the frontend dependency-light; use existing pure JavaScript modules.
- Engine code remains importable by Node and Vite.
- A profile migration must preserve existing workout history and create valid
  engine state deterministically.
- A routine occurrence is the primary progression track. Exercise history is
  a fallback only when that occurrence has no applicable log.

## Canonical progression context

The engine owns a pure resolver that accepts a normalized occurrence, its
current plan rule, progression state, occurrence logs, exercise logs, and the
`startFrom` preference. It returns the selected baseline log, whether it was
selected from the slot or exercise fallback, and state reset information.

The resolver compares a canonical fingerprint of the occurrence's current
plan with the plan fingerprint recorded on the baseline log. The fingerprint
covers `sets`, `reps`, `repsMin` and `sec` only; weight is recorded beside it
but is not part of the comparison.

A reset restarts progression from the current plan's sets and reps. It is
triggered when:

- the baseline carries a fingerprint that differs from the current plan
  ("Plan changed"), or
- the baseline carries no fingerprint and was borrowed from the exercise
  fallback ("First time in this routine").

A baseline from the fallback whose fingerprint matches the current plan
progresses normally. An occurrence's own baseline without a fingerprint never
triggers a reset.

On reset the load is held at the baseline's lifted weight. The plan's weight
replaces it only when the plan's weight differs from the weight recorded with
the baseline fingerprint (an edit such as 3 × 5 @ 100 → 3 × 10 @ 70). A
loaded exercise logged at 0 falls back to the plan's weight; a timed exercise
holds at the plan's seconds.

## Prescription behavior

`generatePrescription` consumes the resolved context rather than performing
history selection itself. The current plan controls sets and reps by default.
When `startFrom` is explicitly `last`, the selected baseline's completed reps
may seed the repetition target; a rule that decides reps itself still wins,
and it never changes the selected progression track or disables the
edited-plan reset. A profile that never chose reads as `plan`.

The existing engine rules continue to decide load, deloads, 1RM-derived loads,
and warm-ups after the context has been resolved.

## Adapters and migration

`frontend/src/lib/session-start.js` normalizes profile data into engine facts
and turns the prescription into session rows. It does not independently
choose history, restart a plan, or choose repetitions. It must keep the
v1.3.9 entry contract:

- `planned`: the plan fingerprint stamped on every built entry, so the next
  session can tell an edited plan from a progressed one.
- `carried`: written only when working rows opened at the last session's reps
  rather than the plan's.
- `plannedConfigOf(entry)`: the mid-session settings sheet opens at the
  planned sets and reps, not the progressed target, so a save without changes
  is not read as a plan edit.
- `builtOutOfProgression(entry, routine)`: only an entry whose routine is
  excluded from progression is rebuilt without a prescription; a hand-set
  `noProg` keeps today's prescription.

Migration converts legacy logs into occurrence-linked records where their
routine entry permits it. It copies a log's existing `planned` stamp into its
fingerprint and never stamps the current plan onto an unstamped log, so the
reset rules above treat legacy history exactly as v1.3.9 does. Unlinked
legacy exercise logs remain valid fallback history.

## Verification

Engine tests prove plan-owned reps, `startFrom: 'last'`, occurrence-first
history with exercise fallback, plan-edit reset with the held load, the
borrowed-baseline reset, and the unstamped-legacy cases. A frontend lifecycle
test proves session construction faithfully uses the engine result and keeps
the entry contract. The frontend, API, and MCP test suites and the frontend
production build must pass.
