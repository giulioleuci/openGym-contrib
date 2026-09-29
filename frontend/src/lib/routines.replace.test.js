import { describe, expect, it } from 'vitest'
import { replaceSlotExercise } from './routines.js'
import { defaultPlanRule } from './prescription/index.js'

const BENCH = '0025', PULLUP = '0652', TREADMILL = '3666'
const slot = (exerciseId, over = {}) => ({ occurrenceId: 'o1', exerciseId, rule: { ...defaultPlanRule('linear', { id: 'o1', exerciseId, routineId: 'r', unit: 'kg' }), revision: 3 }, ...over })

describe('replaceSlotExercise', () => {
  it('picking the exercise already in the slot changes nothing', () => {
    const s = slot(BENCH)
    expect(replaceSlotExercise(s, BENCH, { unit: 'kg' }, 'r')).toEqual(s)
  })

  it('the same kind of work keeps the rule, note and superset, on a new occurrence with its own progression line', () => {
    const s = slot(BENCH, { note: 'pause', sg: 'g' })
    const out = replaceSlotExercise(s, '0026', { unit: 'kg' }, 'r')
    expect(out).toMatchObject({ exerciseId: '0026', note: 'pause', sg: 'g' })
    expect(out.occurrenceId).not.toBe('o1')
    expect(out.rule).toMatchObject({ id: out.occurrenceId, exerciseId: '0026', preset: 'linear', revision: 1 })
    expect(out.rule.parameters).toEqual(s.rule.parameters)
  })

  it('between kinds (lifting ↔ cardio) only the note and superset survive; the rule is the new exercise\'s default', () => {
    const out = replaceSlotExercise(slot(BENCH, { note: 'x', sg: 'g' }), TREADMILL, { unit: 'kg' }, 'r')
    expect(out).toMatchObject({ exerciseId: TREADMILL, note: 'x', sg: 'g' })
    expect(out.rule.preset).toBe('manual')
  })
})
