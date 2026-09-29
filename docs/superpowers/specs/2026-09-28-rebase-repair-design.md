# Rebase repair — PR #312 CI green-up design

## Context

PR #312 (`DuarteSantos8/openGym`, branch `feat/generic-engine-v1.3.12-issue186`)
rebases a squashed "generic engine v2" implementation onto v1.3.9, per the
maintainer's own review comment
([#312#issuecomment-5875341126](https://github.com/DuarteSantos8/openGym/pull/312#issuecomment-5875341126)).

A prior session landed the engine's session semantics
(`docs/superpowers/plans/2026-09-28-engine-session-semantics.md`: routine-first
history #216, plan-owned reps + edited-plan reset #275, migration carries
planned/rid/startFrom) and 4 small CI fixes (`3918e41`, `48722e9`), cutting
failures from 191→135 API and 156→139 frontend. Both GitHub Actions checks are
still red — this spec covers the rest of that repair.

Counts re-verified against a fresh local run at the time of writing (not
assumed from prior session notes): **135/502 API tests failing**
(`cd api && node --test`), **139/2408 frontend tests failing across 125
files** (`cd frontend && npx vitest run`).

## Root-cause findings

### API: one dominant cause, not many small ones

`api/server.js` lost ~1100 lines and 20 whole routes when the engine-v2 branch
was squashed on top of v1.3.9. `password.js`, `rate-limit.js`,
`device-link.js`, `media.js` are present and byte-identical to v1.3.9 in
`api/` — `server.js` simply stopped importing and registering them. Diffing
route tables (`v1.3.9:api/server.js` vs `HEAD:api/server.js`) shows exactly
these routes gone:

```
account passkeys: GET/POST/DELETE /api/account/passkeys(+rename)
password:         POST /api/login/password, /api/register/password,
                   /api/login/password-reset,
                   GET/POST/DELETE /api/account/password,
                   POST /api/admin/user/password-reset
email:             POST/DELETE /api/account/email
device-link:       POST /api/account/device-link,
                   /api/device-link/options, /api/device-link/verify
media:             PUT/GET /api/media/{hash}, POST /api/media/missing,
                   /api/media/sweep
```

This explains `server-passkeys.test.js`(28) + `server-password.test.js`(25) +
`server-media.test.js`(24) + `server-email.test.js`(11) + most of
`validate.test.js`(10) + `openapi-routes.test.js`(3) +
`server-config-session.test.js`(4) — **~105 of 135 API failures**, one root
cause. Fix is restoration (port the missing imports + route bodies from
`v1.3.9:api/server.js`, adapt to whatever current helper names — session/user/
audit/`atomicWrite` — drifted since v1.3.9), not new-feature work.

Full current API failure breakdown (file : failing subtests):

```
28 server-passkeys.test.js        3 payload.test.js
25 server-password.test.js        3 openapi-routes.test.js
24 server-media.test.js           2 server-token-refresh.test.js
11 server-email.test.js           2 server-state-read-cost.test.js
10 validate.test.js               2 server-state-cache-bounds.test.js
 9 payload-bounds.test.js         2 server-push-prune-save.test.js
 4 server-config-session.test.js  2 server-admin-state.test.js
                                  2 jobs.test.js
 1 server-data-rev.test.js        1 review-repair.test.js
 1 server-data-reset.test.js      1 payload-parity.test.js  (OUT OF SCOPE, see below)
 1 server-body-errors.test.js     1 dockerfile-copy.test.js
```

### Frontend: two independent phenomena, not one

**(a) 91 files are pure import-cascade damage, not 91 bugs.** They fail with
`Error: Failed to resolve import "./progression.js"` or
`"./finish-workout.js"` at Vite transform time (0 tests collected — vitest's
default reporter's grouped `FAIL` blocks made this look like dozens of
one-off failures; the JSON reporter (`--reporter=json`) gives the true,
deduplicated per-file counts used throughout this spec). Three production
files are the entry points:

- `frontend/src/lib/routines.js:4` — `import { sessionsFor } from
  './progression.js'`, used by `Plan.jsx`, `RoutineEdit.jsx`
- `frontend/src/lib/plates.js:15` — `import { weightIncrement } from
  './progression.js'`
- `frontend/src/lib/session-edit.js:13` — `import { buildCompletedWorkout }
  from './finish-workout.js'`, pulled in transitively by `useStore.js`,
  which is why the cascade reaches nearly every view/store/sheet test.

Confirmed by spike: porting these isn't a signature-level patch. v1's
`sessionsFor(S, exId, fallback, rid)` walks `S.workouts[].entries[]` directly;
v2's equivalent data lives in `w.exposures[]` (see `history.js`'s
`workoutVolume`). Writing a v2-correct replacement is real engine-shape work,
same category as the already-excluded v1-progression test importers — just a
much larger file list than originally estimated. **Confirmed out of scope.**
A guard test already encodes the intended end state and is expected to stay
red: `frontend/src/lib/no-legacy-progression.test.js` (asserts zero files
import `progression.js`/`finish-workout.js` — 1/4 subtests failing today,
correctly, since the migration hasn't happened).

**(b) 138 real, actionable failures across ~34 files** — the part this repair
fixes:

```
Settings cluster (52, fully mocked — vi.mock('../store/useStore.js', ...),
no real server, so unrelated to the API finding above; root cause is a real
UI/copy/structure regression in Settings.jsx or its children):
  15 Settings.server-sync.test.jsx   3 Settings.password.test.jsx
   9 Settings.media.test.jsx         2 Settings.logref.test.jsx
   6 Settings.reset.test.jsx         2 Settings.speed.test.jsx
   5 Settings.passkeys.test.jsx      2 Settings.startfrom.test.jsx
   4 Settings.account-id.test.jsx
   4 Settings.sound.test.jsx

useStore engine-state cluster (32, plausibly tied to the S.active/A
architecture split noted from the rebase-conflict resolution pass):
  13 useStore.active.test.jsx
  10 useStore.tabs.test.jsx
   9 useStore.migration.test.jsx   (corrected: does NOT import
                                     finish-workout.js/progression.js —
                                     confirmed in-scope, was previously
                                     miscategorized as an out-of-scope
                                     importer)

History/volume v1-v2 shape cluster (23, plausibly one shared cause with the
already-known workout-text.js issue):
  11 plan-print.test.js
   7 Stats.recovery.test.jsx
   3 workout-text.test.js
   2 Stats.speed.test.jsx

Independent one-offs (31):
   4 Heatmap.test.jsx            2 list-columns.test.js
   4 Workout.storage.test.jsx    1 check-locales.test.mjs
   3 mobile.autobackup.test.js   1 android-system-bars.test.js
   2 Toast.test.js               1 native-keyboard.test.js
   2 coach.test.js               1 pt-br-locale.test.js
   2 onerm.test.js               1 units.test.js
   2 plan-share.test.js          1 CoachChat.demo-failure.test.jsx
   2 speed.test.js
   2 strength-exercises.test.js
```

### Out of scope (unchanged principle, corrected file list)

Real rewrites against the deleted v1 engine, not patches — tracked
separately, not touched by this repair:

- `frontend/src/lib/routines.js`, `frontend/src/lib/plates.js`,
  `frontend/src/lib/session-edit.js` (production files still calling deleted
  `progression.js`/`finish-workout.js`)
- The 91 test files that fail to load as a result (full list captured during
  triage; includes every `sheets.*.test.jsx`, most `store/useStore.*.test.jsx`,
  several `views/Plan.*`/`views/RoutineEdit.*`/`views/Workout.*`)
- `frontend/src/lib/no-legacy-progression.test.js` (1/4 — guard test,
  expected to stay red)
- `api/test/payload-parity.test.js` (1 — imports
  `frontend/src/lib/progression.js` directly)

**Completion criterion:** after this repair, `node --test` in `api/` should
have exactly 1 residual failure (`payload-parity.test.js`), and
`npx vitest run` in `frontend/` should have exactly 1 residual *assertion*
failure (`no-legacy-progression.test.js`, 1 of its 4 subtests) plus the 91
files that fail to load (0 collected tests each) — both residuals expected
and pre-existing, not introduced by this work.

## Task list (subagent-driven-development, one task per coherent root cause)

1. **Restore dropped API route surface.** Port the 4 missing imports and 20
   missing routes (passkeys-mgmt, password, email, device-link, media) from
   `v1.3.9:api/server.js` into current `server.js`. `password.js`/
   `rate-limit.js`/`device-link.js`/`media.js` are untouched — wire-up, not
   rewrite. Adapt to any helper-name drift since v1.3.9 (session/user/audit/
   `atomicWrite`). Targets ~105 API failures.
2. **`payload.js` equipment sanitize + intake-bounding.** Guard non-array
   `profile.equipment` before it reaches `library.js`'s `librarySlice`
   (`(equipment || []).map is not a function`); implement
   `PROFILE_WORD_MAX`/`PROFILE_EQUIPMENT_MAX`/per-field length caps that
   `payload-bounds.test.js`/`payload.test.js` expect (currently
   `200000 !== 600`-style gaps — caps aren't applied at all). ~13 API tests.
3. **Settings cluster root-cause + fix.** Investigate first — fully mocked,
   so this is a genuine UI/copy/structure regression in `Settings.jsx` or a
   child it renders, not a wiring gap. 52 failures across 10 files; may
   resolve to 1-3 actual defects once root-caused.
4. **`useStore` engine-state cluster root-cause + fix.** `active`(13) +
   `tabs`(10) + `migration`(9) = 32 failures; investigate whether they share
   one cause (candidate: the `S.active`/`A` architecture split from the
   rebase's conflict resolution).
5. **History/volume v1-v2 shape fix.** Fix `workout-text.js`'s own
   `workoutVolume` callers to build the `{exposures}` shape — do **not**
   touch `workoutVolume`'s `(S, w)` signature (already correct per 10+
   passing `history.test.js` tests; a prior attempt to change the signature
   broke those and had to be reverted). Also `setLabel` drop-set arrow
   formatting, mph speed conversion. Check whether `plan-print.test.js` /
   `Stats.recovery.test.jsx` / `Stats.speed.test.jsx` share the same root
   cause before treating them as separate. ~23 tests.
6. **Frontend misc triage.** The 31 independent one-offs — root-cause each,
   split further if a bucket turns out not to share one cause.
7. **API misc triage.** ~20 remaining: openapi.yaml `Data` tag,
   `server.requestTimeout`, dockerfile-copy, jobs/token-refresh/state-cache/
   push-prune/admin-state/data-rev/data-reset/body-errors/review-repair.
8. **Final whole-branch review.** Full re-run of both suites; reconcile
   residual failures against the exact out-of-scope list above (expect 1 API
   + 1 frontend assertion + 91 frontend unloadable files, nothing else); push
   `git push origin feat/generic-engine-v1.3.12-issue186` (plain
   fast-forward); confirm on GitHub CI (`gh pr checks 312 --repo
   DuarteSantos8/openGym`, `gh run watch`); post a PR comment in the style of
   the existing `#312` comment (cite issue numbers, file:line, explicit about
   polished vs. rough, cite the out-of-scope list explicitly so the
   maintainer knows the 91-file gap is understood and tracked, not missed).

## Constraints (repo-wide, apply to every task)

- No TypeScript, no linter/formatter — match each file's own style by hand:
  no semicolons in `api/engine` and `frontend/src`; semicolons in
  `api/migration`, `api/test`, and `api/` root files (`server.js`,
  `coach/*.js`).
- Dependency-light: frontend is React + Router + Zustand only, `api/` has two
  dependencies. No new deps — restoring `password.js`/`media.js`/etc. adds
  none, they're already present.
- `api/engine` imports nothing outside `api/engine`
  (`api/test/boundaries.test.js` is a naive text regex checking for the
  literal substring `from"` — watch for `from"` appearing inside any comment
  written anywhere in `api/`, not just `api/engine`).
- Training-logic changes need a unit test beside the code.
- Never commit `media/` or `data/`.
- Every task re-runs `cd api && node --test` and `cd frontend && npx vitest
  run` **in full** (not just the touched file) before being marked done —
  the workoutVolume-signature mistake in the prior session was only caught by
  a full re-run, not a targeted one.
- Commits end with the `Co-Authored-By`/`Claude-Session` trailer given in
  the session's system context.

## Testing / verification approach

Per task: root-cause via the actual failing assertion/error (not "looks
right"), fix, run both full suites, confirm the target bucket's count drops
to the expected residual and nothing else regresses. Task review after each
(per `subagent-driven-development`). Final task re-verifies against GitHub's
own CI run, not just local — local/CI have shown ~2-test drift before.
