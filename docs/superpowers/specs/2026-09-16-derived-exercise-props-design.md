# Derived exercise properties — data foundation and manual-override model

**Status:** approved design (brainstorming)
**Date:** 2026-09-16
**Scope:** data foundation + override layer only. No curated batch of values, no UI, no filters, no coach integration.

## Problem

The exercise catalogue carries no movement-classification metadata. We want two orthogonal,
derived axes on every exercise in the app catalogue:

1. **Movement direction** — `push` / `pull` / `static` (plus `mixed` for genuinely ambiguous
   movements), at both the muscle level (`MUSCLE_DIR` table) and the exercise level (derived).
2. **Joint coverage** — `compound` / `isolation`. Unreliable to derive from the raw dataset
   (the number of named muscles does not equal the number of joints; bench press, OHP, bent-over
   row and pull-up all sit at the same count as half the catalogue), so it needs an explicit
   per-exercise value, seeded by a conservative auto-classifier and correctable by hand.

This spec lays the **model and the override mechanism** for both axes. It deliberately stores no
curated values yet: the need to hand-classify 1,324 exercises is a separate, ongoing curation
effort that this foundation enables.

## Existing precedent

`frontend/src/lib/exercises.js` already applies owner-approved metadata as a runtime overlay:
`exerciseMuscleMetadataFor(id)` merges curated `primaries`/`secondaries`/`bp` (sourced from
`exercise-muscle-batch-1.json` and `exercise-muscle-batch-2.json`) onto the raw `EXDB` dataset
inside `catalogueExercise()`. Raw `EXDB` is never mutated, so imports/exports/historical tests
keep reading the upstream shape. This spec extends that same overlay mechanism; it does not
invent a new one.

## Vocabulary

Direction (`dir`): `'push' | 'pull' | 'static' | 'mixed' | undefined`
Joint coverage (`arel`): `'compound' | 'isolation' | undefined`

`undefined` means "not classified" — an absent field on the exercise object. Absence never means
"other" and never excludes an exercise from a filter.

## Components

### `frontend/src/lib/exercise-derived.js` (new, pure, no framework import)

Owns the derivation functions, the default per-muscle table, and the override map — mirroring how
`exercise-muscle-batch-1.js` keeps its resolver and owner overrides together.

**`MUSCLE_DIR`** — lookup slug → direction. Every entry of `MUSCLES` (muscles.js:16) must be
present. Unknown muscles resolve to `undefined` (never invented).

| dir | muscles |
|---|---|
| `push` | chest, triceps, deltoids, serratus, quadriceps, gluteal, calves |
| `pull` | upper-back, biceps, trapezius, forearm, hamstring, tibialis, hip-flexors |
| `static` | abs, obliques, lower-back |
| `mixed` | adductors |

`'cardiovascular system'` is not in `MUSCLES`'s drawable set and falls out as `undefined`.

**`dirOf(ex)`** — majority vote over the exercise's **primary** muscles (enriched `primaries`,
falling back to `tg`). Requires canonicalization: export the currently-private
`canonicalMuscle` from `muscles.js` (one-line change). Votes: push = +1, pull = −1, static and
mixed abstain.

- votes > 0 → `push` (bench: chest; squat: quads + glutes)
- votes < 0 → `pull` (bent-over row, pull-up: upper-back)
- 0 with opposing votes → `mixed` (deadlift: gluteal push vs hamstring pull — a known
  threshold mislabel that the override layer exists to fix)
- 0 with no votes → `static` if any static primary (plank: abs), `mixed` if only mixed
  (hip adduction), else `undefined` (cardio)

**`seedArel(ex)`** — conservative auto-classifier from the count of distinct canonical muscles
(`tg`/`mg`/`sm`, or `primaries`/`secondaries` when present). Thresholds measured against the real
dataset (distribution 1:23, 2:364, 3:721, 4:184, ≥5:32):

- distinct ≤ 1 → `isolation` (all 23 are definite single-joint movements)
- distinct ≥ 5 → `compound` (all 32 are definite: squats, deadlifts, burpees, muscle-ups)
- 2–4 → `undefined` (the ambiguous zone — bench/OHP/row/pull-up all sit at 3)

Thresholds are named constants so the classifier can be tuned.

**`DERIVED_PROPS_OVERRIDES`** — `Object.freeze({})`, keyed by exercise id, partial per-field:
`{ '0032': { dir: 'pull' } }`. Starts empty (this spec covers the foundation, not the curation).
Every value must belong to the vocabulary (enforced by test #6).

**`derivedPropsOf(ex)`** — three-level precedence, specular to `catalogueExercise`:
1. explicit `dir`/`arel` on the exercise object (custom exercise, or a future dataset row)
   — wins
2. `DERIVED_PROPS_OVERRIDES[ex.id]` — wins over the derivation
3. derivation (`dirOf` + `seedArel`)

Returns `{ dir, arel }` containing only classified values; `undefined` results are omitted so
they are never written onto the exercise object.

### `frontend/src/lib/exercises.js` (edit)

`catalogueExercise()` applies the muscle overlay first, then `derivedPropsOf(out)` on the
enriched object — so the direction derivation sees the corrected `primaries`, not the raw `tg`.
Assigns `out.dir` / `out.arel` when present. Raw `EXDB` untouched.

### `frontend/src/lib/muscles.js` (edit)

Export `canonicalMuscle` (currently private).

### `scripts/derive-exercise-props.mjs` (new, Node script)

Loads `EXDB` + the pure derivation (the existing module graph already loads under plain Node,
see the `import.meta.env` guards) and prints a reviewable candidate to stdout:
`[{ id, n, dir, arel }]` for exercises that have a derived value. This is the
`derive → review → override` bridge: the owner scans the dump and moves only the corrections
into `DERIVED_PROPS_OVERRIDES`. No CLI flags, no file writes — stdout only, owner redirects.

## Data flow

```
EXDB (raw, never mutated)
  → catalogueExercise():
    1. muscle metadata overlay (existing)      → enriched primaries
    2. derivedPropsOf(out):                    → dir derived from primaries/tg
                                                  arel seeded by count or undefined
    3. override / explicit fields win
  → CATALOGUE / EXIDX                       carry dir, arel when classified
```

Custom exercises flow through `EXIDX` unchanged; `derivedPropsOf` works on them because they
carry `primaries`/`secondaries`. Explicit `dir`/`arel` on a custom exercise win by precedence 1.

## Error handling and edge cases

- Unknown muscle → `undefined`, never an invented direction.
- `undefined` results omitted — an exercise that is not classified simply lacks the field.
- Ordering is fixed: muscle overlay before derivation, so `dirOf` never sees raw aliases.
- `EXDB` is never mutated (`catalogueExercise` spreads before merging).
- Malformed override values (outside the vocabulary) are caught by tests, not by runtime guards.

## Testing — `frontend/src/lib/exercise-derived.test.js`

1. `MUSCLE_DIR` covers every entry of `MUSCLES`; every value ∈ vocabulary.
2. `dirOf` on raw rows (tg fallback): sit-up → `static`; calf raise → `push`; cardio → `undefined`.
3. `dirOf` on enriched rows (primaries): bench 0025 → `push`; bent-over row 0027 / pull-up 0652
   → `pull`; squat 0043 → `push`; deadlift 0032 → `mixed`; hip adduction → `mixed`.
4. `seedArel`: calf raise → `isolation`; squat → `compound`; bench → `undefined` (ambiguous zone).
5. Precedence: explicit object field > override map > derivation (exercised via a custom
   exercise carrying explicit values).
6. Vocabulary validation of every entry in `DERIVED_PROPS_OVERRIDES` (vacuous while empty, live
   the day curation starts).
7. Integration: after `catalogueExercise`, `EXIDX['0025'].dir === 'push'`; the matching raw
   `EXDB` row has no `dir` property (no mutation).

## Out of scope (deliberately)

Curated values (`DERIVED_PROPS_OVERRIDES` stays empty), UI badges/tags, picker filters, search
weighting, coach payload/prompts. Each is a later step that consumes this foundation.

## Commands

```bash
cd frontend && npx vitest run src/lib/exercise-derived.test.js   # new tests
cd frontend && npm test                                          # full suite, no regressions
node scripts/derive-exercise-props.mjs                           # candidate dump (dev tool)
```

## Conventions

Match the existing style: no framework imports in `src/lib`, constants frozen like the muscle
batches, tests beside the code, no new dependencies.