import { describe, expect, it } from 'vitest'
import { latestPatrolGrades, preferredPatrolGrade } from '../src/utils/scoringPatrolGrade'

describe('月度评分关联巡查评级', () => {
  it('优先采用巡查评级，无巡查时回退月度评分等级', () => {
    expect(preferredPatrolGrade('B', 'C')).toBe('C')
    expect(preferredPatrolGrade('C', 'A')).toBe('A')
    expect(preferredPatrolGrade('B')).toBe('B')
    expect(preferredPatrolGrade(undefined, 'C')).toBe('C')
    expect(preferredPatrolGrade()).toBeUndefined()
  })
  it('仅采用所选范围内每家工厂最新有效巡查，不用未来或其他工厂评级', () => {
    const records = [
      { factory: 'a', check_date: '2026-07-15', grade: 'D' },
      { factory: 'a', check_date: '2026-08-10', grade: 'D' },
      { factory: 'a', check_date: '2026-08-20', grade: 'B' },
      { factory: 'a', check_date: '2026-08-25', grade: '' },
      { factory: 'a', check_date: '2026-09-01', grade: 'C' },
      { factory: 'b', check_date: '2026-08-30', grade: 'A' },
    ]
    expect(latestPatrolGrades(records, '2026-08', '2026-08')).toEqual({
      a: { grade: 'B', date: '2026-08-20', id: '' },
      b: { grade: 'A', date: '2026-08-30', id: '' },
    })
    expect(latestPatrolGrades(records, '2026-08', '2026-09').a.grade).toBe('C')
    expect(latestPatrolGrades(records, '2026-06', '2026-06')).toEqual({})
  })
})
