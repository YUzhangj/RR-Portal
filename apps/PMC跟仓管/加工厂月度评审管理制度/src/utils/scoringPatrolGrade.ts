import type { Grade } from '../constants/grading'

export interface PatrolRating {
  id?: string
  factory: string
  check_date: string
  grade?: string
}
const GRADES: Grade[] = ['A', 'B', 'C', 'D']

export function latestPatrolGrades(records: PatrolRating[], start: string, end: string) {
  const result: Record<string, { grade: Grade; date: string; id: string }> = {}
  for (const record of records) {
    const date = String(record.check_date ?? '').slice(0, 10)
    const month = date.slice(0, 7)
    const grade = String(record.grade ?? '').trim().toUpperCase() as Grade
    if (!record.factory || !/^\d{4}-\d{2}-\d{2}$/.test(date) || month < start || month > end || !GRADES.includes(grade)) continue
    const current = result[record.factory]
    const id = record.id ?? ''
    if (!current || date > current.date || (date === current.date && id > current.id)) {
      result[record.factory] = { grade, date, id }
    }
  }
  return result
}

export function lowerGrade(monthly?: Grade, patrol?: Grade): Grade | undefined {
  if (!monthly) return patrol
  if (!patrol) return monthly
  return GRADES[Math.max(GRADES.indexOf(monthly), GRADES.indexOf(patrol))]
}
