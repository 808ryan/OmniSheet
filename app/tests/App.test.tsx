// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../src/App'
import * as api from '../src/lib/api'
import { buildDefaultReportingState } from '../src/lib/reporting'
import { buildDefaultSummaryLayoutState } from '../src/lib/summaryLayout'
import type { TimelineEntry, TimelineWeekView } from '../src/lib/types'

vi.mock('../src/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof api>()
  return Object.fromEntries(Object.entries(original).map(([name, value]) => [
    name,
    name === 'AppCommandError' || name === 'isAppCommandError' ? value : vi.fn(),
  ]))
})
vi.mock('../src/lib/runtime', () => ({ isAppRuntime: () => true, isTauriRuntime: () => false }))

function entry(date: string, index = 0): TimelineEntry {
  return {
    id: `${date}-${index}`, date, startMinute: 480 + index * 60, endMinute: 540 + index * 60,
    durationMinutes: 60, description: `${date} activity ${index}`, userSubmissionText: '',
    source: 'manual', confidence: 1, engagementId: null, activityId: null,
    engagementCode: null, engagementName: null, engagementType: null,
    activityCode: null, activityName: null, usedActivityFallback: false,
    usedTemporalFallback: false, durationDefaulted: false, fallbackSummary: null,
    sourceMessageEntryIndex: null, sourceMessageEntryCount: null,
    modelUsed: null, modelUsedLabel: null, transcriptionModelUsed: null,
    transcriptionModelUsedLabel: null, warningFlags: [], createdAt: 0, updatedAt: 0,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 19, 23, 59, 30))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  HTMLElement.prototype.scrollTo = vi.fn()
  vi.mocked(api.engagementList).mockResolvedValue([])
  vi.mocked(api.timerGetActive).mockResolvedValue(null)
  vi.mocked(api.quickAddSuggestions).mockResolvedValue({ suggestions: [] })
  vi.mocked(api.summaryLayoutStateGet).mockResolvedValue(buildDefaultSummaryLayoutState())
  vi.mocked(api.reportingStateGet).mockResolvedValue(buildDefaultReportingState())
  vi.mocked(api.settingsGetStatus).mockResolvedValue({
    hasOpenAiKey: false, storageHealth: 'ok', keySource: 'none', statusLevel: 'ok', lastError: null,
    selectedOpenAiModel: 'gpt-5.5-instant', availableOpenAiModels: [],
    selectedCalendarBulkModel: 'gpt-5.5-instant', selectedTranscriptionModel: 'gpt-4o-mini-transcribe',
    availableTranscriptionModels: [], timelineExcludeUncategorizedFromDailyTotals: false,
    timelineShowUncategorizedDailyTotal: false, timelineIncludeExternalInTotals: true,
    timelineIncludeInternalInTotals: true, timelineSeparateEngagementTypeTotals: false,
    timelineWeekStartDay: 'saturday', calendarBulkIgnoredKeywords: [],
    calendarBulkIgnoreAllDayEvents: true, showDiagnosticsTab: false,
    quickAddPreferences: {
      engagementOrder: [], hiddenEngagementIds: [], activityOrder: {}, hiddenActivityIds: [],
    },
  })
  vi.mocked(api.timelineMonthSummary).mockResolvedValue([])
  vi.mocked(api.timelineListForDate).mockImplementation(async ({ date }) => (
    Array.from({ length: date === '2026-09-19' ? 8 : 2 }, (_, index) => entry(date, index))
  ))
  vi.mocked(api.timelineListForWeekView).mockImplementation(async ({ date }) => ({
    weekStartDate: date, weekEndDate: date, days: [{ date }], entries: [entry(date)],
  }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () => root.render(<App />))
}

async function selectDay(day: number) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.mini-calendar-day')]
    .find((candidate) => candidate.classList.contains('current-month') && candidate.textContent === `${day}`)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

function selectedDay() {
  return container.querySelector('.mini-calendar-day.is-selected')?.textContent
}

function blockCount() {
  return container.querySelectorAll('.timeline-grid[aria-label="Timeline entries"] .timeline-block').length
}

describe('timeline lifecycle', () => {
  it('follows today after overnight resume without reinitializing, and preserves yesterday’s entries', async () => {
    await render()
    expect(selectedDay()).toBe('19')
    expect(blockCount()).toBe(8)

    vi.setSystemTime(new Date(2026, 8, 20, 9))
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(selectedDay()).toBe('20')
    expect(blockCount()).toBe(2)
    expect(api.settingsGetStatus).toHaveBeenCalledTimes(1)
    expect(api.engagementList).toHaveBeenCalledTimes(1)

    await selectDay(19)
    expect(blockCount()).toBe(8)
  })

  it('keeps a historical date and all its blocks selected across midnight', async () => {
    await render()
    await selectDay(18)
    expect(blockCount()).toBe(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
    expect(selectedDay()).toBe('18')
    expect(blockCount()).toBe(2)
    expect(api.timelineListForDate).toHaveBeenLastCalledWith({ date: '2026-09-18' })
    expect(api.settingsGetStatus).toHaveBeenCalledTimes(1)
  })

  it('follows today at midnight even without a focus or visibility event', async () => {
    await render()
    expect(blockCount()).toBe(8)
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
    expect(selectedDay()).toBe('20')
    expect(blockCount()).toBe(2)
    expect(api.settingsGetStatus).toHaveBeenCalledTimes(1)
  })

  it('handles a multi-day, month-boundary resume on visibility change', async () => {
    await render()
    vi.setSystemTime(new Date(2026, 9, 2, 9))
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(selectedDay()).toBe('2')
    expect(container.querySelector('.mini-calendar-title')?.textContent).toContain('October')
    expect(api.timelineListForDate).toHaveBeenLastCalledWith({ date: '2026-10-02' })
    expect(api.settingsGetStatus).toHaveBeenCalledTimes(1)
  })

  it('ignores an older day response after navigating to another date', async () => {
    await render()
    const oldRequest = deferred<TimelineEntry[]>()
    vi.mocked(api.timelineListForDate).mockImplementationOnce(() => oldRequest.promise)
    await selectDay(18)
    await selectDay(17)
    expect(blockCount()).toBe(2)
    await act(async () => oldRequest.resolve([entry('2026-09-18')]))
    expect(selectedDay()).toBe('17')
    expect(blockCount()).toBe(2)
  })

  it('ignores an older response even after returning to its date', async () => {
    await render()
    const oldRequest = deferred<TimelineEntry[]>()
    vi.mocked(api.timelineListForDate).mockImplementationOnce(() => oldRequest.promise)
    await selectDay(18)
    await selectDay(17)
    await selectDay(18)
    await act(async () => oldRequest.resolve([entry('2026-09-18')]))
    expect(selectedDay()).toBe('18')
    expect(blockCount()).toBe(2)
  })

  it('loads a day selected while startup is still pending', async () => {
    const startup = deferred<Awaited<ReturnType<typeof api.engagementList>>>()
    vi.mocked(api.engagementList).mockReturnValueOnce(startup.promise)
    await render()
    await selectDay(18)
    await act(async () => startup.resolve([]))
    expect(api.timelineListForDate).toHaveBeenLastCalledWith({ date: '2026-09-18' })
    expect(blockCount()).toBe(2)
  })

  it('ignores a stale week response after selecting a different week', async () => {
    await render()
    const oldRequest = deferred<TimelineWeekView>()
    vi.mocked(api.timelineListForWeekView).mockReturnValueOnce(oldRequest.promise)
    const weekTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === 'Week')
    expect(weekTab).toBeDefined()
    await act(async () => weekTab!.click())
    await selectDay(10)
    await act(async () => oldRequest.resolve({
      weekStartDate: '2026-09-19', weekEndDate: '2026-09-25',
      days: [{ date: '2026-09-19' }], entries: Array.from({ length: 8 }, (_, i) => entry('2026-09-19', i)),
    }))
    expect(selectedDay()).toBe('10')
    expect(container.querySelectorAll('.week-timeline-grid .timeline-block').length).toBe(1)
  })
})
