# Engine Session Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The generic engine (`api/engine`) reproduces openGym v1.3.9 session semantics — routine-first history with exercise fallback, plan-owned sets/reps, `startFrom: 'last'`, edited-plan reset with held load — and the session adapter only wires it.

**Architecture:** One new pure engine module, `api/engine/context.js`, picks the baseline log and decides a reset by comparing plan fingerprints. `generatePrescription` takes that result (`reset`, `heldLoad`, `startFrom`) and stamps `planFingerprint` on every prescription. `session-start.js` calls the resolver instead of its own `lastLogFor`; `session-ui-adapter.js` exposes `planned`/`carried` on UI entries; the v1→v2 migration copies a log's v1 `planned` stamp into its prescription fingerprint.

**Tech Stack:** Plain ES modules, Vitest (frontend + engine tests under `frontend/src/lib/prescription/`), `node:test` (API tests under `api/test/`).

**Spec:** `docs/superpowers/specs/2026-09-28-engine-session-semantics-design.md`

## Global Constraints

- Frontend dependencies: React + Router + Zustand only. No new dependency anywhere.
- `api/engine` imports nothing outside `api/engine`; it must run under bare Node and Vite.
- The engine is pure: same inputs → same prescription (no clock, no random, no I/O).
- Profile migration must preserve workout history and be deterministic.
- No TypeScript, no linter: match the surrounding style (2-space, no semicolons in `api/engine` and `frontend/src`; semicolons in `api/migration` and `api/test`).
- Training-logic changes carry a unit test beside the code.
- Commit messages end with the attribution lines from the session's system reminder.

## Review Focus

1. A hand-excluded (`excludedFromProgression`) newer log on the occurrence's own track must be skipped; the older counted log is the baseline. → Task 1, test "skips an excluded log on its own track".
2. A prescription built on this branch before this change has no `planFingerprint`; its own track must progress normally, never reset. → Task 1, test "never resets its own track from an unstamped prescription".
3. A reset on a `percent_1rm` rule must keep the percent expression, not turn it into an absolute load, and must not increment. → Task 2, test "keeps a percent rule's expression on reset, without the step".
4. A reset whose baseline has no lifted load (bodyweight, or a loaded lift logged at 0) opens at the plan's own load. → Task 2, test "opens at the plan's load when nothing was lifted".
5. A `hold_seconds` prescription whose window has slid still fingerprints as its rule, so it never reads as an edit. → Task 1, test "keeps the rule's fingerprint for a hold whose window slid".

Known ceiling (not fixed here): a v1 deload/`noProg` entry migrated as unlinked legacy history is prescription-less, so the resolver reads it as fallback history. Marked with a `ponytail:` comment in Task 1.

Spec's v1.3.9 entry contract, mapped to the engine: `planned` and `carried` → Task 3 (`entriesForExposures`). `plannedConfigOf` needs no code — the settings sheet edits the rule via `ruleOfPrescription`, which reads plan parameters, not the progressed prefill; Task 1's round-trip test pins that it never reads as an edit. `builtOutOfProgression` needs no code — exclusion lives on the exposure (`excludedFromProgression`) and never rebuilds the prescription; Task 1's excluded-log test pins that it never counts.

Out of scope: the rest of the rebase repair. The frontend suite currently has ~157 failing tests unrelated to session semantics (locales, Heatmap, plan-print, …). This plan's gate is the files it touches plus the engine suite; the spec's full-suite gate is met when the rebase repair lands.

---

### Task 1: Progression context resolver

**Files:**
- Create: `api/engine/context.js`
- Modify: `api/engine/index.js` (add one export line)
- Modify: `api/engine/generate.js` (stamp `planFingerprint` on every prescription)
- Test: `frontend/src/lib/prescription/context.test.js`

**Interfaces:**
- Consumes: `canonicalJSON` from `api/engine/canonical.js`.
- Produces:
  - `generatePrescription({ …, fingerprint })` — every prescription carries `planFingerprint: string | null`; `fingerprint` `undefined` = this rule's, anything else is recorded as given (migration, Task 4).
  - `planFingerprint(rule) → string` — canonical JSON of `{ sets, reps, durationSeconds }` from `rule.parameters`; weight excluded.
  - `resolveProgressionContext({ trackId, exerciseId, rule, workouts = [], prescriptions = {}, progression = {} }) → { baseline, source, reset, state, lastPrescription, heldLoad }` where `baseline` is an exposure or `null`, `source` is `'slot' | 'exercise' | null`, `reset` is `'plan_changed' | 'first_in_routine' | null`, `state` is a ProgressionState or `null` (always `null` when `reset`), `lastPrescription` is a prescription or `null`, `heldLoad` is `{ value, unit }` or `null`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/prescription/context.test.js`:

```js
import { describe, expect, it } from 'vitest'
import { defaultPlanRule } from '../../../../api/engine/rules.js'
import { generatePrescription, ruleOfPrescription } from '../../../../api/engine/generate.js'
import { planFingerprint, resolveProgressionContext } from '../../../../api/engine/context.js'

const NOW = '2026-09-24T10:00:00.000Z'
const kg = value => ({ value, unit: 'kg' })
// Linear with no terminal target, so no load is capped.
const plan = (sets, reps, weight = 60) => {
  const r = defaultPlanRule('linear', { id: 'rule1', exerciseId: 'ex1', routineId: 'A', unit: 'kg' })
  return { ...r, target: { mode: 'none' }, completion: [], parameters: { ...r.parameters, sets: { min: sets, max: sets }, reps: { min: reps, max: reps }, load: { mode: 'absolute', value: weight, unit: 'kg' } } }
}
const gen = (id, trackId, rule) => generatePrescription({ id, now: NOW, trackId, rule })
const work = w => ({ role: 'work', status: 'completed', observations: [{ metric: 'repetitions', unit: 'reps', value: 10 }], resistance: { kind: 'external-load', value: w, unit: 'kg' } })
const logged = (p, { trackId = 'occA', exposureId = 'x1', load = 60, excluded = false } = {}) => ({
  exposureId, exerciseId: 'ex1', trackId, prescriptionId: p?.id ?? null, excludedFromProgression: excluded || !p,
  ...(p ? { actual: { sets: 3, reps: 10, load: kg(load) } } : {}),
  performance: { sets: [work(load)] }
})
const resolve = (rule, workouts, prescriptions, progression = {}) =>
  resolveProgressionContext({ trackId: 'occA', exerciseId: 'ex1', rule, workouts, prescriptions, progression })

describe('planFingerprint', () => {
  it('changes with sets or reps, not with weight', () => {
    expect(planFingerprint(plan(3, 10, 60))).toBe(planFingerprint(plan(3, 10, 80)))
    expect(planFingerprint(plan(3, 10))).not.toBe(planFingerprint(plan(3, 12)))
    expect(planFingerprint(plan(3, 10))).not.toBe(planFingerprint(plan(4, 10)))
  })

  it('is stamped on every prescription, and a rule rebuilt from it has the same one', () => {
    const p = gen('p1', 'occA', plan(3, 10))
    expect(p.planFingerprint).toBe(planFingerprint(plan(3, 10)))
    expect(planFingerprint(ruleOfPrescription(p, 'A'))).toBe(p.planFingerprint)
  })

  it('keeps the rule\'s fingerprint for a hold whose window slid', () => {
    const r = defaultPlanRule('hold_seconds', { id: 'rule2', exerciseId: 'ex1', routineId: 'A', unit: 'kg' })
    const first = gen('h1', 'occA', r)
    const state = { status: 'active', readyToIncrement: false, planRuleRevision: 1, position: 2 }
    const slid = generatePrescription({ id: 'h2', now: NOW, trackId: 'occA', rule: r, state, lastPrescription: first, lastLog: { id: 'l1', actual: { sets: 3, reps: 1, durationSeconds: 30 }, audit: [] } })
    expect(slid.parameters.durationSeconds.min).toBeGreaterThan(r.parameters.durationSeconds.min)
    expect(planFingerprint(ruleOfPrescription(slid, 'A'))).toBe(slid.planFingerprint)
  })

  it('records the fingerprint it is given, including none', () => {
    expect(generatePrescription({ id: 'p1', now: NOW, trackId: 'occA', rule: plan(3, 10), fingerprint: null }).planFingerprint).toBe(null)
    expect(generatePrescription({ id: 'p1', now: NOW, trackId: 'occA', rule: plan(3, 10), fingerprint: 'x' }).planFingerprint).toBe('x')
  })
})

describe('resolveProgressionContext', () => {
  it('reads the occurrence\'s own last log before a newer one from another routine', () => {
    const r = plan(3, 10)
    const pA = gen('pA', 'occA', r), pB = gen('pB', 'occB', r)
    const workouts = [{ exposures: [logged(pA, { exposureId: 'xA' })] }, { exposures: [logged(pB, { trackId: 'occB', exposureId: 'xB', load: 80 })] }]
    const ctx = resolve(r, workouts, { pA, pB })
    expect(ctx).toMatchObject({ source: 'slot', reset: null, lastPrescription: pA, heldLoad: kg(60) })
    expect(ctx.baseline.exposureId).toBe('xA')
  })

  it('falls back to another routine\'s log and progresses from it when its plan was the same', () => {
    const r = plan(3, 10)
    const pB = gen('pB', 'occB', r)
    const stateB = { trackId: 'occB', status: 'active', readyToIncrement: true, planRuleRevision: 1, position: 0, lastPrescriptionId: 'pB' }
    const ctx = resolve(r, [{ exposures: [logged(pB, { trackId: 'occB', load: 80 })] }], { pB }, { occB: stateB })
    expect(ctx).toMatchObject({ source: 'exercise', reset: null, state: stateB, lastPrescription: pB, heldLoad: kg(80) })
  })

  it('restarts from the plan when the fallback log was built from a different plan', () => {
    const pB = gen('pB', 'occB', plan(3, 15))
    const ctx = resolve(plan(3, 10), [{ exposures: [logged(pB, { trackId: 'occB' })] }], { pB }, { occB: { status: 'active' } })
    expect(ctx).toMatchObject({ source: 'exercise', reset: 'plan_changed', state: null })
  })

  it('treats imported or legacy history as a first time in this routine, holding what was lifted', () => {
    const ctx = resolve(plan(3, 10), [{ exposures: [logged(null, { trackId: null, load: 72.5 })] }], {})
    expect(ctx).toMatchObject({ source: 'exercise', reset: 'first_in_routine', lastPrescription: null, heldLoad: kg(72.5) })
  })

  it('resets its own track after the plan\'s reps were edited', () => {
    const pA = gen('pA', 'occA', plan(3, 5))
    const ctx = resolve(plan(3, 10), [{ exposures: [logged(pA)] }], { pA }, { occA: { status: 'active', readyToIncrement: true, lastPrescriptionId: 'pA' } })
    expect(ctx).toMatchObject({ source: 'slot', reset: 'plan_changed', state: null, lastPrescription: pA })
  })

  it('skips an excluded log on its own track', () => {
    const r = plan(3, 10)
    const p1 = gen('p1', 'occA', r), p2 = gen('p2', 'occA', r)
    const workouts = [{ exposures: [logged(p1, { exposureId: 'counted' })] }, { exposures: [logged(p2, { exposureId: 'deload', excluded: true, load: 30 })] }]
    expect(resolve(r, workouts, { p1, p2 }).baseline.exposureId).toBe('counted')
  })

  it('never resets its own track from an unstamped prescription', () => {
    const r = plan(3, 10)
    const { planFingerprint: _, ...unstamped } = gen('pA', 'occA', plan(3, 5))
    const ctx = resolve(r, [{ exposures: [logged(unstamped)] }], { pA: unstamped })
    expect(ctx).toMatchObject({ source: 'slot', reset: null })
  })

  it('has no baseline for an exercise never logged', () => {
    expect(resolve(plan(3, 10), [], {})).toMatchObject({ baseline: null, source: null, reset: null, state: null, lastPrescription: null, heldLoad: null })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/prescription/context.test.js`
Expected: FAIL — `Failed to load url ../../../../api/engine/context.js`.

- [ ] **Step 3: Write minimal implementation**

Create `api/engine/context.js`:

```js
// Which logged session a prescription starts from, and whether the plan was edited since
// (openGym v1.3.9, issues #216 and #275). Pure: the caller passes the profile's workouts,
// prescriptions and progression; generatePrescription consumes the result.
import { canonicalJSON } from './canonical.js'

/** The part of a rule that, edited, restarts progression: sets, reps and a declared hold. Weight is not in it. */
export function planFingerprint(rule) {
  const p = rule.parameters
  return canonicalJSON({ sets: p.sets, reps: p.reps, durationSeconds: p.durationSeconds ?? null })
}

const isWork = row => row.status === 'completed' && row.role !== 'warmup'

/** The lightest completed working load of a log: its summary, else its rows (legacy and imported history). */
function liftedLoad(x) {
  if (x.actual?.load) return { ...x.actual.load }
  const loads = (x.performance?.sets || []).filter(r => isWork(r) && r.resistance?.kind === 'external-load')
  if (!loads.length) return null
  const min = loads.reduce((a, b) => (b.resistance.value < a.resistance.value ? b : a)).resistance
  return { value: min.value, unit: min.unit }
}

function newest(workouts, match) {
  for (let i = workouts.length - 1; i >= 0; i--) {
    const exposures = workouts[i].exposures || []
    for (let j = exposures.length - 1; j >= 0; j--) if (match(exposures[j])) return exposures[j]
  }
  return null
}

/**
 * The occurrence's own newest counted log comes first (#216). Only when it has none, the
 * exercise's newest log anywhere: a prescription-less one is imported or legacy history, never
 * counted on a track but still what was last lifted.
 * ponytail: a v1 deload entry migrated unlinked is prescription-less too, so it reads as fallback
 * history; mark it at migration if that bites.
 *
 * A reset (#275): the baseline's recorded plan differs from this rule's, or the baseline was
 * borrowed and records no plan. An own log with no recorded plan never resets.
 */
export function resolveProgressionContext({ trackId, exerciseId, rule, workouts = [], prescriptions = {}, progression = {} }) {
  const own = newest(workouts, x => x.trackId === trackId && x.prescriptionId && !x.excludedFromProgression)
  const borrowed = own ? null : newest(workouts, x => x.exerciseId === exerciseId
    && (!x.prescriptionId || !x.excludedFromProgression) && (x.performance?.sets || []).some(isWork))
  const baseline = own || borrowed
  const source = own ? 'slot' : borrowed ? 'exercise' : null
  const state = (baseline?.trackId && progression[baseline.trackId]) || null
  const lastPrescription = prescriptions[state?.lastPrescriptionId ?? baseline?.prescriptionId] || null
  const recorded = lastPrescription?.planFingerprint ?? null
  const reset = recorded ? (recorded !== planFingerprint(rule) ? 'plan_changed' : null)
    : source === 'exercise' ? 'first_in_routine' : null
  return { baseline, source, reset, state: reset ? null : state, lastPrescription, heldLoad: baseline ? liftedLoad(baseline) : null }
}
```

In `api/engine/index.js`, add after the `generate.js` export line:

```js
export { planFingerprint, resolveProgressionContext } from './context.js'
```

In `api/engine/generate.js`, add to the imports:

```js
import { planFingerprint } from './context.js'
```

Append to the JSDoc params, after `input.equipment`:

```js
 * @param {string|null} [input.fingerprint]      the plan this log was built from; default: this rule's
```

Replace the signature line:

```js
export function generatePrescription({ id, now, trackId, rule, state = null, lastPrescription = null, lastLog = null, oneRm = null, warmup = null, equipment = null }) {
```

with:

```js
export function generatePrescription({ id, now, trackId, rule, state = null, lastPrescription = null, lastLog = null, oneRm = null, warmup = null, equipment = null, fingerprint }) {
```

In `body`, replace:

```js
    id, generatedAt: now, planRuleId: rule.id, planRuleRevision: rule.revision,
```

with:

```js
    id, generatedAt: now, planRuleId: rule.id, planRuleRevision: rule.revision,
    planFingerprint: fingerprint === undefined ? planFingerprint(rule) : fingerprint,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/prescription`
Expected: PASS (the new file, and the existing engine tests unchanged: the stamp only adds a field).

- [ ] **Step 5: Commit**

```bash
git add api/engine/context.js api/engine/index.js api/engine/generate.js frontend/src/lib/prescription/context.test.js
git commit -m "feat(engine): resolve the progression baseline and plan-edit reset"
```

---

### Task 2: `generatePrescription` consumes the context

**Files:**
- Modify: `api/engine/generate.js` (signature; `state` reset; load expression; `fresh`; prefill block)
- Test: `frontend/src/lib/prescription/generate.test.js` (append one `describe`)

**Interfaces:**
- Consumes: `generatePrescription({ …, fingerprint })` as left by Task 1.
- Produces: `generatePrescription` also accepts `reset = null` (`'plan_changed' | 'first_in_routine' | null`), `heldLoad = null` (`{ value, unit }`), `startFrom = 'plan'` (`'plan' | 'last'`). `prefill.carried: true` appears only when rows opened at last session's reps under `startFrom: 'last'`.

- [ ] **Step 1: Write the failing test**

In `frontend/src/lib/prescription/generate.test.js`, append at the end of the file:

```js
describe('session semantics (v1.3.9)', () => {
  const plan = (sets, reps, weight) => rule('linear', r => ({
    ...r, target: { mode: 'none' }, completion: [],
    parameters: { ...r.parameters, sets: { min: sets, max: sets }, reps: { min: reps, max: reps }, load: { mode: 'absolute', value: weight, unit: 'kg' } }
  }))

  it('opens at the plan\'s reps by default, and at the last logged ones under startFrom: last', () => {
    const r = plan(3, 10, 60)
    const first = gen(r)
    const extra = { id: 'p2', state: active({ readyToIncrement: false }), lastPrescription: first, lastLog: logOf({ sets: 3, reps: 7, load: kg(60) }) }
    expect(gen(r, extra).prefill).toEqual({ sets: 3, reps: 10, load: kg(60) })
    expect(gen(r, { ...extra, startFrom: 'last' }).prefill).toEqual({ sets: 3, reps: 7, load: kg(60), carried: true })
  })

  it('restarts an edited plan at its new reps with the load held at what was lifted, even under startFrom: last', () => {
    const first = gen(plan(3, 5, 100))
    const next = gen(plan(3, 10, 100), { id: 'p2', state: active(), lastPrescription: first, lastLog: logOf({ sets: 3, reps: 5, load: kg(97.5) }), reset: 'plan_changed', heldLoad: kg(97.5), startFrom: 'last' })
    expect(next.parameters.load.resolved).toEqual(kg(97.5))
    expect(next.prefill).toEqual({ sets: 3, reps: 10, load: null })
    expect(next).toMatchObject({ position: 0, statusAtGeneration: 'active' })
  })

  it('opens at the plan\'s new weight when the edit changed it too', () => {
    const first = gen(plan(3, 5, 100))
    const next = gen(plan(3, 10, 70), { id: 'p2', state: active(), lastPrescription: first, lastLog: logOf({ sets: 3, reps: 5, load: kg(100) }), reset: 'plan_changed', heldLoad: kg(100) })
    expect(next.parameters.load.resolved).toEqual(kg(70))
  })

  it('holds the lifted load from borrowed history that has no prescription', () => {
    const next = gen(plan(3, 10, 60), { reset: 'first_in_routine', heldLoad: kg(80), lastLog: { id: 'legacy', audit: [] } })
    expect(next.parameters.load.resolved).toEqual(kg(80))
  })

  it('opens at the plan\'s load when nothing was lifted', () => {
    const next = gen(plan(3, 10, 60), { reset: 'first_in_routine', heldLoad: null, lastLog: { id: 'legacy', audit: [] } })
    expect(next.parameters.load.resolved).toEqual(kg(60))
  })

  it('keeps a percent rule\'s expression on reset, without the step', () => {
    const first = gen(percentLinear(), { oneRm: oneRm(100) })
    const edited = { ...percentLinear(), parameters: { ...percentLinear().parameters, reps: { min: 3, max: 3 } } }
    const next = gen(edited, { id: 'p2', oneRm: oneRm(100), state: active(), lastPrescription: first, lastLog: logOf({ sets: 3, reps: 5, load: kg(60) }), reset: 'plan_changed', heldLoad: kg(60) })
    expect(next.parameters.load.expression).toEqual({ mode: 'percent_1rm', percent: 60 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/prescription/generate.test.js`
Expected: FAIL in `session semantics (v1.3.9)` — prefill still follows the last log for linear; `reset`/`heldLoad` are ignored, so the edited plan increments to 102.5.

- [ ] **Step 3: Write minimal implementation**

In `api/engine/generate.js`:

Below `const PER_ROW_LOADS = …`, add:

```js
// Presets that climb sets or reps from what was managed: they own them over the plan.
const CLIMBING_GATES = ['max_reps', 'max_sets_reps', 'rung']
```

JSDoc — append these params after `input.fingerprint`:

```js
 * @param {string|null} [input.reset]            'plan_changed' | 'first_in_routine' (resolveProgressionContext)
 * @param {Object|null} [input.heldLoad]         the baseline's lifted load, held on a reset
 * @param {string} [input.startFrom]             'plan' (default) | 'last': where sets and reps open
```

Signature — replace:

```js
export function generatePrescription({ id, now, trackId, rule, state = null, lastPrescription = null, lastLog = null, oneRm = null, warmup = null, equipment = null, fingerprint }) {
  const check = validatePlanRule(rule)
  if (!check.ok) throw new Error(`invalid plan rule ${rule?.id}: ${check.errors.join('; ')}`)
```

with:

```js
export function generatePrescription({ id, now, trackId, rule, state = null, lastPrescription = null, lastLog = null, oneRm = null, warmup = null, equipment = null, reset = null, heldLoad = null, startFrom = 'plan', fingerprint }) {
  const check = validatePlanRule(rule)
  if (!check.ok) throw new Error(`invalid plan rule ${rule?.id}: ${check.errors.join('; ')}`)
  // A restarted plan is a fresh track: no earned step, no rung or week, no completed status.
  if (reset) state = null
```

Load expression — replace:

```js
  let expression = carry ? copy(lastPrescription.parameters.load.expression) : copy(p.load)
```

with:

```js
  // On a reset the weight holds at what was last lifted, unless the edit changed the plan's own
  // load too — then the new plan's load is where it opens (v1.3.9 #275).
  const hold = !!reset && !!heldLoad && p.load.mode === 'absolute' && (!lastPrescription || same(lastPrescription.basis, p.load))
  let expression = hold ? { mode: 'absolute', value: heldLoad.value, unit: heldLoad.unit }
    : carry ? copy(lastPrescription.parameters.load.expression) : copy(p.load)
```

`fresh` and prefill — replace:

```js
  const fresh = !lastLog || !carry || increments || lastPrescription.position !== position
  const last = lastLog?.actual || {}
  const prefill = {
    sets: fresh ? p.sets.min : (last.sets || p.sets.min),
    reps: fresh ? p.reps.min : (last.reps ?? p.reps.min),
    ...(duration ? { durationSeconds: fresh ? duration.min : (last.durationSeconds ?? duration.min) } : {}),
    ...(!fresh && last.rir != null ? { rir: last.rir } : {}),
    load: !fresh && !PER_ROW_LOADS.includes(rule.preset) && last.load ? copy(last.load) : null
  }
```

with:

```js
  const fresh = !!reset || !lastLog || !carry || increments || lastPrescription.position !== position
  // The plan owns sets, reps and a hold's seconds (v1.3.9 "Planned sessions start from"), unless
  // the athlete chose their last session or the preset climbs them. History decides the weight.
  const fromLast = !fresh && (startFrom === 'last' || CLIMBING_GATES.includes(PRESETS[rule.preset].gate))
  const last = lastLog?.actual || {}
  const prefill = {
    sets: fromLast ? (last.sets || p.sets.min) : p.sets.min,
    reps: fromLast ? (last.reps ?? p.reps.min) : p.reps.min,
    ...(duration ? { durationSeconds: fromLast ? (last.durationSeconds ?? duration.min) : duration.min } : {}),
    ...(!fresh && last.rir != null ? { rir: last.rir } : {}),
    load: !fresh && !PER_ROW_LOADS.includes(rule.preset) && last.load ? copy(last.load) : null
  }
  // Rows open at last session's reps rather than the plan's: the workout card says so.
  if (startFrom === 'last' && fromLast && prefill.reps !== p.reps.min) prefill.carried = true
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/prescription`
Expected: PASS. If an older `generate.test.js` case asserted a non-climbing preset (linear, manual, pyramid…) prefilling the last logged sets/reps, that assertion encoded the old behaviour: change it to pass `startFrom: 'last'` and keep the expectation.

- [ ] **Step 5: Commit**

```bash
git add api/engine/generate.js frontend/src/lib/prescription/generate.test.js
git commit -m "feat(engine): plan-owned reps, startFrom last and edited-plan reset"
```

---

### Task 3: Session adapter wiring

**Files:**
- Modify: `frontend/src/lib/session-start.js` (drop `lastLogFor`; use the resolver)
- Modify: `frontend/src/lib/session-ui-adapter.js` (`planned`, `carried` on entries)
- Modify: `frontend/src/lib/session-start.test.js` (drop the `lastLogFor` import and assertion; add lifecycle tests)
- Delete: `frontend/src/lib/session-start.plan.test.js` (v1.3.9 test against the removed `buildSessionEntries`/`finish-workout.js`; its behaviours are now pinned by Tasks 1–3)

**Interfaces:**
- Consumes: `resolveProgressionContext` (Task 1), `generatePrescription({ reset, heldLoad, startFrom })` (Task 2), `ruleOfPrescription` (existing), all via `./prescription/index.js`.
- Produces: `buildSessionExposures(profile, routine, ctx)` unchanged signature, now reading `profile.startFrom`. `entriesForExposures` entries gain `planned: { sets, reps?, repsMin?, sec? }` (v1 shape, read by `session-routines.js`, `units.js`, `session-edit.js`) and `carried: true` when `prescription.prefill.carried`.

- [ ] **Step 1: Write the failing test**

In `frontend/src/lib/session-start.test.js`, change the imports to:

```js
import { describe, expect, it } from 'vitest'
import { buildSessionExposures, missingOneRms, occurrenceFor } from './session-start.js'
import { entriesForExposures } from './session-ui-adapter.js'
import { loggedExposure, ruleOccurrence } from './test-fixtures.js'
import { EXIDX, isAssisted } from './exercises.js'
```

Delete the line `expect(lastLogFor(S, 'occ-0025').exposureId).toBe(first.exposureId)`.

Append:

```js
describe('session semantics through buildSessionExposures', () => {
  const uncapped = (sets, reps, weight) => ruleOccurrence('0025', { patch: r => ({
    ...r, target: { mode: 'none' }, completion: [],
    parameters: { ...r.parameters, sets: { min: sets, max: sets }, reps: { min: reps, max: reps }, load: { mode: 'absolute', value: weight, unit: 'kg' } }
  }) })

  it('opens a routine at its own plan and the weight last lifted elsewhere', () => {
    const S = profile({ workouts: [{ id: 'w0', exposures: [loggedExposure('0025', [{ r: 15, w: 50 }, { r: 15, w: 50 }])] }] })
    const [x] = buildSessionExposures(S, { id: 'r1', ex: [uncapped(3, 10, 20)] }, ctx)
    const p = S.prescriptions[x.prescriptionId]
    expect(p.parameters.load.resolved).toEqual({ value: 50, unit: 'kg' })
    expect(p.prefill).toMatchObject({ sets: 3, reps: 10 })
  })

  it('restarts an edited routine at its new reps, holds the weight and keeps the entry contract', () => {
    const S = profile()
    const r5 = uncapped(3, 5, 100)
    const [first] = buildSessionExposures(S, { id: 'r1', ex: [r5] }, ctx)
    S.workouts.push({ id: 'w1', exposures: [{ ...first, actual: { sets: 3, reps: 5, load: { value: 100, unit: 'kg' } }, audit: [] }] })
    S.progression['occ-0025'] = { trackId: 'occ-0025', status: 'active', readyToIncrement: true, planRuleRevision: 1, position: 0, lastPrescriptionId: first.prescriptionId }
    const [second] = buildSessionExposures({ ...S, startFrom: 'last' }, { id: 'r1', ex: [uncapped(3, 10, 100)] }, { ...ctx, now: ctx.now + 1 })
    const p = S.prescriptions[second.prescriptionId]
    expect(p.parameters.load.resolved).toEqual({ value: 100, unit: 'kg' })
    expect(p.prefill).toMatchObject({ sets: 3, reps: 10 })
    const [entry] = entriesForExposures([second], S.prescriptions)
    expect(entry.planned).toEqual({ sets: 3, reps: 10 })
    expect(entry.carried).toBeUndefined()
  })

  it('marks an entry whose rows open at last session\'s reps', () => {
    const S = profile({ startFrom: 'last' })
    const r = uncapped(3, 10, 60)
    const [first] = buildSessionExposures(S, { id: 'r1', ex: [r] }, ctx)
    S.workouts.push({ id: 'w1', exposures: [{ ...first, actual: { sets: 3, reps: 8, load: { value: 60, unit: 'kg' } }, audit: [] }] })
    S.progression['occ-0025'] = { trackId: 'occ-0025', status: 'active', readyToIncrement: false, planRuleRevision: 1, position: 0, lastPrescriptionId: first.prescriptionId }
    const [second] = buildSessionExposures(S, { id: 'r1', ex: [r] }, { ...ctx, now: ctx.now + 1 })
    const [entry] = entriesForExposures([second], S.prescriptions)
    expect(entry).toMatchObject({ carried: true, planned: { sets: 3, reps: 10 } })
    expect(entry.sets.map(s => s.r)).toEqual([8, 8, 8])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/session-start.test.js`
Expected: FAIL in the new `describe` — the first test opens at the rule's 20 kg (no fallback), the second increments to 102.5, entries have no `planned`.

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/lib/session-start.js`:

Replace the import line and delete `lastLogFor` (the doc comment and the whole function):

```js
import { currentOneRm, defaultPlanRule, generatePrescription, needsOneRm, resolveProgressionContext, supports } from './prescription/index.js'
```

In `buildSessionExposures`, replace:

```js
    const trackId = occ.occurrenceId
    const state = profile.progression?.[trackId] || null
    const lastLog = lastLogFor(profile, trackId)
    const prescription = generatePrescription({
      id: ctx.newId(`prescription:${routine.id}:${occ.occurrenceId}:${ctx.now}:${i}`),
      now: new Date(ctx.now).toISOString(),
      trackId, rule: occ.rule, state,
      lastPrescription: profile.prescriptions[state?.lastPrescriptionId ?? lastLog?.prescriptionId] || null,
      // The engine reads a log's id; a saved exposure carries it as exposureId.
      lastLog: lastLog && { ...lastLog, id: lastLog.exposureId },
```

with:

```js
    const trackId = occ.occurrenceId
    // The engine picks the history and decides a restart; this boundary only passes the profile.
    const context = resolveProgressionContext({
      trackId, exerciseId: occ.exerciseId, rule: occ.rule,
      workouts: profile.workouts, prescriptions: profile.prescriptions, progression: profile.progression
    })
    const prescription = generatePrescription({
      id: ctx.newId(`prescription:${routine.id}:${occ.occurrenceId}:${ctx.now}:${i}`),
      now: new Date(ctx.now).toISOString(),
      trackId, rule: occ.rule, state: context.state, lastPrescription: context.lastPrescription,
      // The engine reads a log's id; a saved exposure carries it as exposureId.
      lastLog: context.baseline && { ...context.baseline, id: context.baseline.exposureId },
      reset: context.reset, heldLoad: context.heldLoad, startFrom: profile.startFrom,
```

In `frontend/src/lib/session-ui-adapter.js`:

Change the import to:

```js
import { auditExecution, normalizeEffort, ruleOfPrescription } from './prescription/index.js'
```

Below `loadStepFor`, add:

```js
// What the routine asked for, in the v1 entry shape the copy-routine and unit readers use: the
// rule's own sets and reps, never today's progressed prefill (session-routines.js).
export function plannedOf(p) {
  const { sets, reps, durationSeconds } = ruleOfPrescription(p).parameters
  if (durationSeconds) return { sets: sets.min, sec: durationSeconds.min }
  return { sets: sets.min, reps: reps.max, ...(reps.min !== reps.max ? { repsMin: reps.min } : {}) }
}
```

In `entriesForExposures`, after the `target:` line add:

```js
      planned: plannedOf(p),
      ...(p.prefill.carried ? { carried: true } : {}),
```

Delete the legacy test:

```bash
git rm frontend/src/lib/session-start.plan.test.js
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/session-start.test.js src/lib/session-ui-adapter.test.js src/lib/prescription-lifecycle.test.js src/lib/finish-session.test.js src/lib/prescription`
Expected: PASS. If a pre-existing assertion does `toEqual` on a whole entry, add `planned` to its expected object (the value `plannedOf` returns for that prescription); do not loosen it to `toMatchObject`.

Then: `grep -rn "lastLogFor" frontend/src` → only `history.js`'s unrelated `lastEntryFor` family may match; no `lastLogFor` left.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/session-start.js frontend/src/lib/session-ui-adapter.js frontend/src/lib/session-start.test.js
git commit -m "feat(session): build sessions from the engine's progression context"
```

---

### Task 4: Migration carries the v1 plan stamp

**Files:**
- Modify: `api/migration/profile-migration.js` (engine import; `links.push`; `finalizeDraft`'s `generatePrescription` call)
- Test: `api/test/profile-migration.test.js` (append one `test`)

**Interfaces:**
- Consumes: `planFingerprint` (Task 1), `generatePrescription({ fingerprint })` (Task 2).
- Produces: every migrated linked prescription has `planFingerprint` = fingerprint of the entry's v1 `planned` stamp, or `null` when the entry had none. Nothing else changes.

- [ ] **Step 1: Write the failing test**

In `api/test/profile-migration.test.js`, change the engine import to:

```js
import { generatePrescription, planFingerprint } from '../engine/index.js';
```

Append:

```js
test('a v1 plan stamp becomes the log\'s plan fingerprint; an unstamped log records none', () => {
  const stamped = v1();
  stamped.workouts[0].entries[0].planned = { sets: 3, reps: 5, weight: 60 };
  stamped.routines[0].ex[0].reps = 8;   // the routine was edited after that session
  const { profile } = migrate(stamped);
  const logged = profile.prescriptions[profile.workouts[0].exposures[0].prescriptionId];
  assert.equal(logged.planFingerprint, planFingerprint({ parameters: { sets: { min: 3, max: 3 }, reps: { min: 5, max: 5 } } }));
  assert.notEqual(logged.planFingerprint, planFingerprint(profile.routines[0].ex[0].rule));

  const { profile: bare } = migrate(v1());
  assert.equal(bare.prescriptions[bare.workouts[0].exposures[0].prescriptionId].planFingerprint, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test test/profile-migration.test.js`
Expected: FAIL — the stamped log's fingerprint is its progressed target's (and the unstamped one is not `null`).

- [ ] **Step 3: Write minimal implementation**

In `api/migration/profile-migration.js`:

Add `planFingerprint` to the names imported from `'../engine/index.js'` (the import ending at line 22).

In the history-linking loop, replace:

```js
    if (d) d.links.push({ i, j, workoutId: ctx.workoutIds[i], at: iso(whenOf(workouts[i])), values: targetValues(entry.target) });
```

with:

```js
    if (d) d.links.push({ i, j, workoutId: ctx.workoutIds[i], at: iso(whenOf(workouts[i])), values: targetValues(entry.target), planned: isObj(entry.planned) ? entry.planned : null });
```

In `finalizeDraft`, replace:

```js
      link.prescription = generatePrescription({ id: `${link.workoutId}:p${link.j}`, now: link.at, trackId: d.occurrenceId, rule: d.ruleFor(link.values) });
```

with:

```js
      // The plan the session was built from (v1 `planned`), never the progressed target: an
      // unstamped log records none, so the engine reads it the way v1.3.9 did.
      const fingerprint = link.planned ? planFingerprint(d.ruleFor({ repsMin: null, repsMax: link.planned.reps, ...link.planned })) : null;
      link.prescription = generatePrescription({ id: `${link.workoutId}:p${link.j}`, now: link.at, trackId: d.occurrenceId, rule: d.ruleFor(link.values), fingerprint });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && node --test test/profile-migration.test.js test/engine-gate.test.js`
Expected: PASS.

Run: `cd frontend && npx vitest run src/lib/prescription src/lib/session-start.test.js src/store/useStore.migration.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/migration/profile-migration.js api/test/profile-migration.test.js
git commit -m "feat(migration): carry the v1 plan stamp into the prescription fingerprint"
```
