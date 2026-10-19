import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import QualityPatrolCompare from '../src/components/QualityPatrolCompare.vue'
const factories = [{ id: 'a', name: '甲厂' }, { id: 'b', name: '乙厂' }] as any
const records = [
  { id: '3', factory: 'a', check_date: '2026-10-16', grade: 'A', staff: 50, evaluation: '第三次' },
  { id: '1', factory: 'a', check_date: '2026-08-18', grade: 'C', staff: 30, evaluation: '第一次' },
  { id: '2', factory: 'a', check_date: '2026-09-18', grade: 'B', staff: 40, evaluation: '第二次', photos: ['x.jpg'] },
  { id: '4', factory: 'b', check_date: '2026-10-16', grade: 'D', staff: 20, evaluation: '其他工厂' },
] as any
const props = { records, factories, photoUrl: () => '/photo?token=protected', photoReady: true, photoError: '' }
describe('multi-visit comparison', () => {
  it('compares three actual visits chronologically, highlights changes and isolates factories', async () => {
    const w = mount(QualityPatrolCompare, { props })
    expect(w.findAll('thead th').map(el => el.text())).toEqual(['巡查项目', '2026-08-18', '2026-09-18', '2026-10-16'])
    expect(w.find('tbody').text()).not.toContain('其他工厂')
    expect(w.findAll('tbody tr')[0]!.findAll('td').map(td => td.text())).toEqual(['30','40','50'])
    expect(w.findAll('tbody tr')[0]!.findAll('.changed')).toHaveLength(2)
    expect(w.find('img').attributes('src')).toContain('token=protected')
    await w.findAll('input[type=checkbox]')[1]!.setValue(false)
    expect(w.findAll('thead th')).toHaveLength(3)
    await w.find('select').setValue('b')
    expect(w.text()).toContain('不足两次')
    expect(w.find('table').exists()).toBe(false)
    w.unmount()
  })
  it('does not load protected photos without a token', () => {
    const w = mount(QualityPatrolCompare, { props: { ...props, photoReady: false } })
    expect(w.find('img').exists()).toBe(false)
    expect(w.text()).toContain('照片暂不可用')
    w.unmount()
  })
})
