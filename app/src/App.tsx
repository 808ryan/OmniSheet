import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'

import {
  activityDelete,
  activityUpsert,
  diagnosticsCopyBundle,
  diagnosticsList,
  engagementDelete,
  engagementList,
  engagementUpsert,
  interpretTextMessage,
  maintenanceRepairSuspiciousEntries,
  isAppCommandError,
  settingsGetStatus,
  settingsSetOpenAiKey,
  timelineDeleteEntry,
  timelineListForDate,
  timelineMonthSummary,
  timelineUpdateEntry,
} from './lib/api'
import { isTauriRuntime } from './lib/runtime'
import {
  formatDate,
  joinTags,
  minuteToLabel,
  minuteToTimeInput,
  parseTagInput,
  shiftDate,
  timeInputToMinute,
} from './lib/time'
import type {
  Activity,
  DiagnosticsEvent,
  Engagement,
  InterpretResult,
  SettingsStatus,
  TimelineDaySummary,
  TimelineEntry,
  WarningType,
} from './lib/types'
import './App.css'

type View = 'timeline' | 'codes' | 'settings' | 'diagnostics'
type DiagnosticsFilter = 'all' | 'errors' | 'warnings' | 'capture' | 'settings'
type MonthSummaryCache = Record<string, TimelineDaySummary[]>

interface CaptureStatus {
  state: 'idle' | 'running' | 'success' | 'error'
  message: string
  correlationId?: string
}

interface EngagementFormState {
  id?: string
  code: string
  name: string
  client: string
  colorHex: string
  describeWhenToUse: string
  tags: string
  isActive: boolean
}

interface ActivityFormState {
  id?: string
  engagementId: string
  code: string
  name: string
  colorHex: string
  describeWhenToUse: string
  tags: string
  isActive: boolean
}

interface EntryDraft {
  id: string
  date: string
  engagementId: string
  activityId: string
  description: string
  startTime: string
  endTime: string
}

interface TimelineWindow {
  startMinute: number
  endMinute: number
}

interface ClippedTimelineEntry {
  entry: TimelineEntry
  clippedStartMinute: number
  clippedEndMinute: number
}

interface PositionedTimelineEntry extends ClippedTimelineEntry {
  laneIndex: number
  laneCount: number
  top: number
  height: number
  leftPercent: number
  widthPercent: number
}

type TimelineLabelTier = 1 | 2 | 3

interface TimelineLabel {
  label: string
  fullLabel: string
  tier: TimelineLabelTier
}

interface MiniCalendarProps {
  selectedDate: string
  visibleMonth: string
  todayDate: string
  daysWithEntries: Set<string>
  isLoading: boolean
  errorMessage: string | null
  onVisibleMonthChange: (nextMonth: string) => void
  onSelectDate: (date: string) => void
}

interface CalendarDayCell {
  date: string
  dayOfMonth: number
  isCurrentMonth: boolean
}

interface TimelineContextMenuState {
  entryId: string
  x: number
  y: number
}

interface RunActionOptions {
  formatError?: (error: unknown) => string
}

const EMPTY_ENGAGEMENT_FORM: EngagementFormState = {
  code: '',
  name: '',
  client: '',
  colorHex: '',
  describeWhenToUse: '',
  tags: '',
  isActive: true,
}

const EMPTY_ACTIVITY_FORM: ActivityFormState = {
  engagementId: '',
  code: '',
  name: '',
  colorHex: '',
  describeWhenToUse: '',
  tags: '',
  isActive: true,
}

const MINUTES_IN_DAY = 24 * 60
const HOUR_IN_MINUTES = 60
const PIXELS_PER_MINUTE = 1
const TIMELINE_CANVAS_TOP_PADDING = 18
const TIMELINE_CANVAS_BOTTOM_PADDING = 20
const TIMELINE_OVERLAP_GAP_PERCENT = 1.2
const TIMELINE_NEUTRAL_COLOR = '#6F7B89'
const FULL_DAY_TIMELINE_WINDOW: TimelineWindow = {
  startMinute: 0,
  endMinute: MINUTES_IN_DAY,
}
const EMPTY_CAPTURE_STATUS: CaptureStatus = {
  state: 'idle',
  message: 'No capture submitted yet.',
}
const SEGMENTED_VIEWS: View[] = ['timeline', 'codes', 'settings', 'diagnostics']
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const

function App() {
  const tauriRuntime = isTauriRuntime()
  const todayDate = useMemo(() => formatDate(new Date()), [])

  const [activeView, setActiveView] = useState<View>('timeline')
  const [isBusy, setIsBusy] = useState(false)
  const [isTimelineLoading, setIsTimelineLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus | null>(null)
  const [openAiKey, setOpenAiKey] = useState('')

  const [engagements, setEngagements] = useState<Engagement[]>([])
  const [engagementForm, setEngagementForm] =
    useState<EngagementFormState>(EMPTY_ENGAGEMENT_FORM)
  const [activityForm, setActivityForm] = useState<ActivityFormState>(EMPTY_ACTIVITY_FORM)

  const [captureMessage, setCaptureMessage] = useState('')
  const [interpretResult, setInterpretResult] = useState<InterpretResult | null>(null)
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>(EMPTY_CAPTURE_STATUS)

  const [selectedDate, setSelectedDate] = useState(todayDate)
  const [visibleMonth, setVisibleMonth] = useState(() => monthKeyFromDate(todayDate))
  const [timelineEntries, setTimelineEntries] = useState<TimelineEntry[]>([])
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [entryDraft, setEntryDraft] = useState<EntryDraft | null>(null)
  const [timelineContextMenu, setTimelineContextMenu] = useState<TimelineContextMenuState | null>(null)
  const [monthSummaryCache, setMonthSummaryCache] = useState<MonthSummaryCache>({})
  const [monthSummaryLoadingMonth, setMonthSummaryLoadingMonth] = useState<string | null>(null)
  const [monthSummaryError, setMonthSummaryError] = useState<string | null>(null)
  const timelineGridRef = useRef<HTMLDivElement | null>(null)
  const timelineContextMenuRef = useRef<HTMLDivElement | null>(null)
  const hasInitializedRef = useRef(false)
  const lastLoadedTimelineDateRef = useRef<string | null>(null)
  const [diagnosticsFilter, setDiagnosticsFilter] = useState<DiagnosticsFilter>('all')
  const [diagnosticsEvents, setDiagnosticsEvents] = useState<DiagnosticsEvent[]>([])
  const [diagnosticsBundleText, setDiagnosticsBundleText] = useState('')

  const selectedEntry = useMemo(
    () => timelineEntries.find((entry) => entry.id === selectedEntryId) ?? null,
    [selectedEntryId, timelineEntries],
  )
  const visibleMonthSummaries = useMemo(
    () => monthSummaryCache[visibleMonth] ?? [],
    [monthSummaryCache, visibleMonth],
  )
  const visibleMonthDaysWithEntries = useMemo(
    () => new Set(visibleMonthSummaries.filter((day) => day.entryCount > 0).map((day) => day.date)),
    [visibleMonthSummaries],
  )
  const visibleMonthSummaryError = monthSummaryCache[visibleMonth] ? null : monthSummaryError
  const hasVisibleMonthSummary = monthSummaryCache[visibleMonth] !== undefined

  const timelineWindow = FULL_DAY_TIMELINE_WINDOW

  const timelineWindowMinutes = timelineWindow.endMinute - timelineWindow.startMinute
  const timelineCanvasHeight = (
    timelineWindowMinutes * PIXELS_PER_MINUTE
      + TIMELINE_CANVAS_TOP_PADDING
      + TIMELINE_CANVAS_BOTTOM_PADDING
  )
  const positionedTimelineEntries = useMemo(
    () => positionTimelineEntries(timelineEntries, timelineWindow),
    [timelineEntries, timelineWindow],
  )

  const timelineHourMarks = useMemo(() => {
    const marks: number[] = []
    const firstHourMark =
      Math.ceil(timelineWindow.startMinute / HOUR_IN_MINUTES) * HOUR_IN_MINUTES

    for (
      let minute = firstHourMark;
      minute <= timelineWindow.endMinute;
      minute += HOUR_IN_MINUTES
    ) {
      marks.push(minute)
    }
    return marks
  }, [timelineWindow.endMinute, timelineWindow.startMinute])

  const availableActivities = useMemo(() => {
    if (!entryDraft?.engagementId) {
      return [] as Activity[]
    }

    const engagement = engagements.find(
      (candidate) => candidate.id === entryDraft.engagementId,
    )

    return engagement?.activities ?? []
  }, [engagements, entryDraft])

  const engagementColorById = useMemo(() => {
    const values = new Map<string, string | null>()
    for (const engagement of engagements) {
      values.set(engagement.id, normalizeColorHexInput(engagement.colorHex))
    }
    return values
  }, [engagements])

  const activityColorById = useMemo(() => {
    const values = new Map<string, string | null>()
    for (const engagement of engagements) {
      for (const activity of engagement.activities) {
        values.set(activity.id, normalizeColorHexInput(activity.colorHex))
      }
    }
    return values
  }, [engagements])

  const selectedActivityEngagement = useMemo(
    () => engagements.find((engagement) => engagement.id === activityForm.engagementId) ?? null,
    [activityForm.engagementId, engagements],
  )

  const engagementFormColorValue = normalizeColorHexInput(engagementForm.colorHex)
  const activityFormColorValue = normalizeColorHexInput(activityForm.colorHex)
  const selectedEngagementColorValue = normalizeColorHexInput(selectedActivityEngagement?.colorHex)

  const loadEngagements = useCallback(async () => {
    const values = await engagementList()
    setEngagements(values)
    setActivityForm((previous) => {
      if (previous.engagementId || values.length === 0) {
        return previous
      }

      return {
        ...previous,
        engagementId: values[0].id,
      }
    })
  }, [])

  const loadSettings = useCallback(async () => {
    const status = await settingsGetStatus()
    setSettingsStatus(status)
  }, [])

  const loadTimeline = useCallback(async (date: string) => {
    const entries = await timelineListForDate({ date })
    lastLoadedTimelineDateRef.current = date
    setTimelineEntries(entries)
    return entries
  }, [])

  const loadTimelineMonthSummary = useCallback(async (month: string) => {
    const rows = await timelineMonthSummary({ month })
    setMonthSummaryCache((previous) => ({
      ...previous,
      [month]: rows,
    }))
    return rows
  }, [])

  const invalidateMonthSummaries = useCallback((monthKeys: string[]) => {
    setMonthSummaryCache((previous) => {
      let changed = false
      const next = { ...previous }

      for (const monthKey of monthKeys) {
        if (next[monthKey]) {
          delete next[monthKey]
          changed = true
        }
      }

      return changed ? next : previous
    })
  }, [])

  const loadDiagnostics = useCallback(async (filter: DiagnosticsFilter) => {
    const events = await diagnosticsList({
      limit: 100,
      filter: filter === 'all' ? undefined : filter,
    })
    setDiagnosticsEvents(events)
  }, [])

  useEffect(() => {
    if (!tauriRuntime) {
      return
    }

    const initialize = async () => {
      try {
        setIsBusy(true)
        await Promise.all([
          loadEngagements(),
          loadSettings(),
          loadTimeline(todayDate),
          loadDiagnostics('all'),
        ])
        hasInitializedRef.current = true
      } catch (error) {
        setErrorMessage((error as Error).message)
      } finally {
        setIsBusy(false)
      }
    }

    void initialize()
  }, [loadDiagnostics, loadEngagements, loadSettings, loadTimeline, tauriRuntime, todayDate])

  useEffect(() => {
    if (!tauriRuntime || !hasInitializedRef.current) {
      return
    }

    if (lastLoadedTimelineDateRef.current === selectedDate) {
      return
    }

    void (async () => {
      try {
        setIsTimelineLoading(true)
        setErrorMessage(null)
        await loadTimeline(selectedDate)
      } catch (error) {
        if (isAppCommandError(error)) {
          setErrorMessage(
            `${error.message} (command: ${error.command}, correlationId: ${error.correlationId})`,
          )
        } else {
          setErrorMessage((error as Error).message)
        }
      } finally {
        setIsTimelineLoading(false)
      }
    })()
  }, [loadTimeline, selectedDate, tauriRuntime])

  useEffect(() => {
    if (!tauriRuntime) {
      return
    }

    if (hasVisibleMonthSummary) {
      return
    }

    let cancelled = false
    const requestedMonth = visibleMonth

    void (async () => {
      try {
        setMonthSummaryLoadingMonth(requestedMonth)
        setMonthSummaryError(null)
        await loadTimelineMonthSummary(requestedMonth)
        if (cancelled) {
          return
        }
      } catch (error) {
        if (cancelled) {
          return
        }
        setMonthSummaryError((error as Error).message)
      } finally {
        setMonthSummaryLoadingMonth((previous) => (
          previous === requestedMonth ? null : previous
        ))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [hasVisibleMonthSummary, loadTimelineMonthSummary, tauriRuntime, visibleMonth])

  useEffect(() => {
    if (selectedEntryId && timelineEntries.every((entry) => entry.id !== selectedEntryId)) {
      setSelectedEntryId(null)
      setEntryDraft(null)
    }

    if (
      timelineContextMenu
      && timelineEntries.every((entry) => entry.id !== timelineContextMenu.entryId)
    ) {
      setTimelineContextMenu(null)
    }
  }, [selectedEntryId, timelineContextMenu, timelineEntries])

  useEffect(() => {
    if (!timelineContextMenu) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) {
        setTimelineContextMenu(null)
        return
      }

      if (timelineContextMenuRef.current?.contains(target)) {
        return
      }

      setTimelineContextMenu(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTimelineContextMenu(null)
      }
    }

    const handleViewportChange = () => {
      setTimelineContextMenu(null)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', handleViewportChange, true)
    window.addEventListener('resize', handleViewportChange)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', handleViewportChange, true)
      window.removeEventListener('resize', handleViewportChange)
    }
  }, [timelineContextMenu])

  useEffect(() => {
    if (!tauriRuntime || activeView !== 'diagnostics') {
      return
    }

    void loadDiagnostics(diagnosticsFilter)
  }, [activeView, diagnosticsFilter, loadDiagnostics, tauriRuntime])

  useEffect(() => {
    if (activeView !== 'timeline' && timelineContextMenu) {
      setTimelineContextMenu(null)
    }
  }, [activeView, timelineContextMenu])

  useEffect(() => {
    if (activeView !== 'timeline') {
      return
    }

    const grid = timelineGridRef.current
    if (!grid) {
      return
    }

    if (lastLoadedTimelineDateRef.current !== selectedDate) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      if (positionedTimelineEntries.length === 0) {
        grid.scrollTop = 0
        return
      }

      const earliestEntry = positionedTimelineEntries.reduce((earliest, current) =>
        current.top < earliest.top ? current : earliest,
      )
      const targetTop = (
        earliestEntry.top
        - (grid.clientHeight / 2)
        + (earliestEntry.height / 2)
      )
      const maxScrollTop = Math.max(0, grid.scrollHeight - grid.clientHeight)
      const clampedScrollTop = Math.min(Math.max(0, targetTop), maxScrollTop)

      grid.scrollTo({
        top: clampedScrollTop,
        behavior: 'auto',
      })
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [activeView, positionedTimelineEntries, selectedDate])

  useEffect(() => {
    if (!successMessage) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setSuccessMessage(null)
    }, 5000)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [successMessage])

  const refreshAfterMutation = useCallback(async () => {
    await Promise.all([loadEngagements(), loadTimeline(selectedDate), loadSettings()])
  }, [loadEngagements, loadSettings, loadTimeline, selectedDate])

  const runAction = useCallback(
    async (action: () => Promise<void>, options?: RunActionOptions) => {
      try {
        setIsBusy(true)
        setErrorMessage(null)
        setSuccessMessage(null)
        await action()
      } catch (error) {
        if (options?.formatError) {
          setErrorMessage(options.formatError(error))
          return
        }

        if (isAppCommandError(error)) {
          setErrorMessage(
            `${error.message} (command: ${error.command}, correlationId: ${error.correlationId})`,
          )
        } else {
          setErrorMessage((error as Error).message)
        }
      } finally {
        setIsBusy(false)
      }
    },
    [],
  )

  const onSubmitCapture = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void (async () => {
      const messageToSend = captureMessage

      try {
        setIsBusy(true)
        setErrorMessage(null)
        setSuccessMessage(null)
        setCaptureStatus({
          state: 'running',
          message: 'Submitting message for interpretation...',
        })

        const submittedAt = new Date()
        const result = await interpretTextMessage({
          rawText: messageToSend,
          clientTimestampIso: submittedAt.toISOString(),
          clientLocalDate: formatDate(submittedAt),
          clientLocalTime: formatLocalTime(submittedAt),
          clientUtcOffsetMinutes: -submittedAt.getTimezoneOffset(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        })

        const selectedDayEntries = await loadTimeline(selectedDate)
        const createdOnSelectedDate = selectedDayEntries.filter((entry) =>
          result.createdEntryIds.includes(entry.id),
        ).length

        setInterpretResult(result)
        setCaptureMessage('')
        const normalizationNote =
          result.normalizationNotes.length > 0
            ? ` ${result.normalizationNotes[0]}`
            : ''

        setCaptureStatus({
          state: 'success',
          message:
            createdOnSelectedDate > 0
              ? `Interpretation completed. ${createdOnSelectedDate} new timeline entr${createdOnSelectedDate === 1 ? 'y' : 'ies'} on selected day.${normalizationNote}`
              : `Interpretation completed, but no new entries landed on the selected day.${normalizationNote}`,
          correlationId: result.correlationId,
        })
        setSuccessMessage('Message interpretation finished.')
        invalidateMonthSummaries([monthKeyFromDate(selectedDate)])
      } catch (error) {
        if (isAppCommandError(error)) {
          setCaptureStatus({
            state: 'error',
            message: error.message,
            correlationId: error.correlationId,
          })
          setErrorMessage(
            `${error.message} (command: ${error.command}, correlationId: ${error.correlationId})`,
          )
        } else {
          const message = (error as Error).message
          setCaptureStatus({
            state: 'error',
            message,
          })
          setErrorMessage(message)
        }
      } finally {
        setIsBusy(false)
      }
    })()
  }

  const onSubmitEngagement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void runAction(async () => {
      const colorHex = normalizeColorHexInput(engagementForm.colorHex)
      if (engagementForm.colorHex.trim().length > 0 && !colorHex) {
        throw new Error('Engagement color must be a valid #RRGGBB value.')
      }

      await engagementUpsert({
        id: engagementForm.id,
        code: engagementForm.code,
        name: engagementForm.name,
        client: engagementForm.client || null,
        colorHex,
        describeWhenToUse: engagementForm.describeWhenToUse.trim() || null,
        tags: parseTagInput(engagementForm.tags),
        isActive: engagementForm.isActive,
      })

      setEngagementForm(EMPTY_ENGAGEMENT_FORM)
      await refreshAfterMutation()
      setSuccessMessage('Engagement saved.')
    }, { formatError: formatCodesMutationError })
  }

  const onDeleteEngagement = (id: string) => {
    void runAction(async () => {
      await engagementDelete(id)
      await refreshAfterMutation()
      setSuccessMessage('Engagement deleted.')
    })
  }

  const onEditEngagement = (engagement: Engagement) => {
    setEngagementForm({
      id: engagement.id,
      code: engagement.code,
      name: engagement.name,
      client: engagement.client ?? '',
      colorHex: engagement.colorHex ?? '',
      describeWhenToUse: engagement.describeWhenToUse ?? '',
      tags: joinTags(engagement.tags),
      isActive: engagement.isActive,
    })
  }

  const onSubmitActivity = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void runAction(async () => {
      const colorHex = normalizeColorHexInput(activityForm.colorHex)
      if (activityForm.colorHex.trim().length > 0 && !colorHex) {
        throw new Error('Activity color must be a valid #RRGGBB value.')
      }

      await activityUpsert({
        id: activityForm.id,
        engagementId: activityForm.engagementId,
        code: activityForm.code,
        name: activityForm.name,
        colorHex,
        describeWhenToUse: activityForm.describeWhenToUse.trim() || null,
        tags: parseTagInput(activityForm.tags),
        isActive: activityForm.isActive,
      })

      setActivityForm((previous) => ({
        ...EMPTY_ACTIVITY_FORM,
        engagementId: previous.engagementId,
      }))
      await refreshAfterMutation()
      setSuccessMessage('Activity saved.')
    }, { formatError: formatCodesMutationError })
  }

  const onDeleteActivity = (id: string) => {
    void runAction(async () => {
      await activityDelete(id)
      await refreshAfterMutation()
      setSuccessMessage('Activity deleted.')
    })
  }

  const onEditActivity = (activity: Activity) => {
    setActivityForm({
      id: activity.id,
      engagementId: activity.engagementId,
      code: activity.code,
      name: activity.name,
      colorHex: activity.colorHex ?? '',
      describeWhenToUse: activity.describeWhenToUse ?? '',
      tags: joinTags(activity.tags),
      isActive: activity.isActive,
    })
  }

  const onSetDate = (nextDate: string) => {
    if (nextDate === selectedDate) {
      return
    }

    setSelectedDate(nextDate)
    setVisibleMonth(monthKeyFromDate(nextDate))
    setSelectedEntryId(null)
    setEntryDraft(null)
    setTimelineContextMenu(null)
  }

  const onSelectCalendarDate = (nextDate: string) => {
    setActiveView('timeline')
    onSetDate(nextDate)
  }

  const onSelectEntry = (entry: TimelineEntry) => {
    setTimelineContextMenu(null)
    setSelectedEntryId(entry.id)
    setEntryDraft({
      id: entry.id,
      date: entry.date,
      engagementId: entry.engagementId ?? '',
      activityId: entry.activityId ?? '',
      description: entry.description,
      startTime: minuteToTimeInput(entry.startMinute),
      endTime: minuteToTimeInput(entry.endMinute),
    })
  }

  const onOpenTimelineContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    entry: TimelineEntry,
  ) => {
    event.preventDefault()
    onSelectEntry(entry)

    const position = clampTimelineContextMenuPosition(event.clientX, event.clientY)
    setTimelineContextMenu({
      entryId: entry.id,
      x: position.x,
      y: position.y,
    })
  }

  const onSaveEntryDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!entryDraft) {
      return
    }

    void runAction(async () => {
      const previousEntryDate = selectedEntry?.date ?? selectedDate
      const previousMonthKey = monthKeyFromDate(previousEntryDate)
      const nextMonthKey = monthKeyFromDate(entryDraft.date)

      await timelineUpdateEntry({
        id: entryDraft.id,
        engagementId: entryDraft.engagementId || null,
        activityId: entryDraft.activityId || null,
        date: entryDraft.date,
        startMinute: timeInputToMinute(entryDraft.startTime),
        endMinute: timeInputToMinute(entryDraft.endTime),
        description: entryDraft.description,
      })

      await loadTimeline(selectedDate)
      invalidateMonthSummaries([previousMonthKey, nextMonthKey])
      setSuccessMessage('Timeline entry updated.')
    })
  }

  const onDeleteTimelineEntry = (id: string) => {
    void runAction(async () => {
      const existingEntry = timelineEntries.find((entry) => entry.id === id) ?? null
      const entryDate = existingEntry?.date ?? selectedDate
      const monthKey = monthKeyFromDate(entryDate)

      await timelineDeleteEntry(id)
      setTimelineContextMenu(null)
      await loadTimeline(selectedDate)
      invalidateMonthSummaries([monthKey])
      setSuccessMessage('Timeline entry deleted.')
    })
  }

  const onSaveApiKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void runAction(async () => {
      await settingsSetOpenAiKey(openAiKey)
      setOpenAiKey('')
      const status = await settingsGetStatus()
      setSettingsStatus(status)

      if (!status.hasOpenAiKey) {
        throw new Error(
          `Key save verification failed. Storage health: ${status.storageHealth}. ${status.lastError ?? ''}`.trim(),
        )
      }

      if (status.statusLevel === 'warning') {
        setSuccessMessage(
          'OpenAI API key saved. Running from in-memory session key because keyring readback is unavailable.',
        )
      } else {
        setSuccessMessage('OpenAI API key saved securely.')
      }
    })
  }

  const onRefreshDiagnostics = () => {
    void runAction(async () => {
      await loadDiagnostics(diagnosticsFilter)
      setSuccessMessage('Diagnostics refreshed.')
    })
  }

  const onCopyDiagnostics = () => {
    void runAction(async () => {
      const bundle = await diagnosticsCopyBundle()
      setDiagnosticsBundleText(bundle.text)

      try {
        await navigator.clipboard.writeText(bundle.text)
        setSuccessMessage('Diagnostics bundle copied to clipboard.')
      } catch {
        setSuccessMessage('Diagnostics bundle generated below (clipboard not available).')
      }
    })
  }

  const onRepairSuspiciousEntries = () => {
    void runAction(async () => {
      const result = await maintenanceRepairSuspiciousEntries({ limit: 300 })
      await Promise.all([loadTimeline(selectedDate), loadDiagnostics(diagnosticsFilter)])
      invalidateMonthSummaries([monthKeyFromDate(selectedDate)])
      setSuccessMessage(
        `Temporal repair complete. Repaired ${result.repairedCount} of ${result.scannedCount} suspicious entries.`,
      )
    })
  }

  if (!tauriRuntime) {
    return (
      <div className="runtime-shell">
        <h1>OmniSheet</h1>
        <p>This application requires the Tauri runtime.</p>
        <p>Start it with `npm run tauri dev` after installing Rust toolchain.</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <div className={`workspace-shell ${activeView === 'timeline' ? 'with-timeline' : 'without-timeline'}`}>
        <aside className="sidebar-panel">
          <div className="sidebar-header">
            <div>
              <p className="app-eyebrow">OmniSheet</p>
              <h1>Capture + Timeline</h1>
            </div>
            <div className="sidebar-header-meta">
              <span>{selectedDate}</span>
              {isBusy ? <span className="status-chip">Working...</span> : null}
            </div>
          </div>

          <section className="sidebar-section sidebar-capture">
            <div className="sidebar-section-header">
              <h2>Capture</h2>
              <p>Submit a message from any view.</p>
            </div>
            <form onSubmit={onSubmitCapture} className="stack">
              <textarea
                value={captureMessage}
                onChange={(event) => setCaptureMessage(event.target.value)}
                placeholder="Example: Just finished a 30 minute SAP ITGC meeting with the Orange team"
                rows={4}
                required
              />
              <button type="submit" disabled={isBusy || captureMessage.trim().length === 0}>
                Interpret + Save
              </button>
            </form>

            <div className={`result-card capture-status compact ${captureStatus.state}`}>
              <h3>Capture Status</h3>
              <p>{captureStatus.message}</p>
              {captureStatus.correlationId ? (
                <p>
                  Correlation ID: <code>{captureStatus.correlationId}</code>
                </p>
              ) : null}
              {interpretResult ? (
                <div className="sidebar-capture-summary">
                  <p>Entries created: {interpretResult.createdEntryIds.length}</p>
                  {interpretResult.warnings.length > 0 ? (
                    <div className="warning-row">
                      {interpretResult.warnings.map((warning) => (
                        <WarningBadge
                          key={`${warning.entryId}-${warning.warningType}`}
                          type={warning.warningType}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          <section className="sidebar-section sidebar-calendar">
            <MiniCalendar
              selectedDate={selectedDate}
              visibleMonth={visibleMonth}
              todayDate={todayDate}
              daysWithEntries={visibleMonthDaysWithEntries}
              isLoading={monthSummaryLoadingMonth === visibleMonth}
              errorMessage={visibleMonthSummaryError}
              onVisibleMonthChange={setVisibleMonth}
              onSelectDate={onSelectCalendarDate}
            />
          </section>
        </aside>

        <main className="app-main">
          <div className="segmented-control" role="tablist" aria-label="Main views">
            {SEGMENTED_VIEWS.map((view) => (
              <button
                key={view}
                type="button"
                role="tab"
                aria-selected={activeView === view}
                className={activeView === view ? 'active' : ''}
                onClick={() => setActiveView(view)}
              >
                {view[0].toUpperCase() + view.slice(1)}
              </button>
            ))}
          </div>

          <div className="app-notices" aria-live="polite">
            {errorMessage ? (
              <div className="alert error" role="alert">
                <span className="alert-message">{errorMessage}</span>
                <button
                  type="button"
                  className="alert-close"
                  aria-label="Dismiss error message"
                  onClick={() => setErrorMessage(null)}
                >
                  ×
                </button>
              </div>
            ) : null}
            {successMessage ? (
              <div className="alert success" role="status">
                <span className="alert-message">{successMessage}</span>
                <button
                  type="button"
                  className="alert-close"
                  aria-label="Dismiss success message"
                  onClick={() => setSuccessMessage(null)}
                >
                  ×
                </button>
              </div>
            ) : null}
          </div>

          <div className={`app-content ${activeView === 'timeline' ? 'timeline-active' : 'wide-active'}`}>

        {activeView === 'timeline' ? (
          <section className="panel timeline-panel">
            <div className="timeline-toolbar">
              <div>
                <h2>Daily Timeline</h2>
                <p className="timeline-range">
                  Visible range: {minuteToLabel(timelineWindow.startMinute)} -{' '}
                  {formatTimelineRangeEndLabel(timelineWindow.endMinute)}
                </p>
              </div>
              <div className="timeline-controls">
                <button
                  type="button"
                  onClick={() => onSetDate(shiftDate(selectedDate, -1))}
                  disabled={isBusy || isTimelineLoading}
                >
                  Previous
                </button>
                <input
                  type="date"
                  value={selectedDate}
                  disabled={isBusy || isTimelineLoading}
                  onChange={(event) => onSetDate(event.target.value)}
                />
                <button
                  type="button"
                  onClick={() => onSetDate(shiftDate(selectedDate, 1))}
                  disabled={isBusy || isTimelineLoading}
                >
                  Next
                </button>
              </div>
            </div>

            <div className="timeline-layout">
              <div
                className="timeline-grid"
                role="list"
                aria-label="Timeline entries"
                aria-busy={isTimelineLoading}
                ref={timelineGridRef}
              >
                <div
                  className="timeline-canvas"
                  style={{ minHeight: `${timelineCanvasHeight}px` }}
                >
                  {timelineHourMarks.map((minute) => (
                    <div
                      key={minute}
                      className="timeline-hour-mark"
                      style={{
                        top:
                          TIMELINE_CANVAS_TOP_PADDING
                          + (minute - timelineWindow.startMinute) * PIXELS_PER_MINUTE,
                      }}
                    >
                      <span>{minuteToLabel(minute)}</span>
                    </div>
                  ))}

                  <div className="timeline-entry-layer">
                    {positionedTimelineEntries.map((positionedEntry) => {
                      const { entry } = positionedEntry
                      const blockColor = resolveTimelineBlockColor(
                        entry,
                        activityColorById,
                        engagementColorById,
                      )
                      const blockLabel = buildTimelineBlockLabel(
                        entry,
                        positionedEntry.widthPercent,
                        positionedEntry.height,
                      )
                      const textColor = colorForBackground(blockColor)

                      return (
                        <button
                          type="button"
                          key={entry.id}
                          className={`timeline-block tier-${blockLabel.tier} ${selectedEntryId === entry.id ? 'selected' : ''}`}
                          style={{
                            top: positionedEntry.top,
                            height: positionedEntry.height,
                            left: `${positionedEntry.leftPercent}%`,
                            width: `${positionedEntry.widthPercent}%`,
                            backgroundColor: blockColor,
                            color: textColor,
                          }}
                          onClick={() => onSelectEntry(entry)}
                          onContextMenu={(event) => onOpenTimelineContextMenu(event, entry)}
                          title={`${blockLabel.fullLabel}\n${entry.description}`}
                          aria-label={`${blockLabel.fullLabel}. ${entry.description}`}
                          aria-haspopup="menu"
                        >
                          <span className="timeline-block-label">{blockLabel.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>

              <aside className="timeline-editor">
                <h3>Edit Entry</h3>
                {entryDraft ? (
                  <form className="stack" onSubmit={onSaveEntryDraft}>
                    <label>
                      Date
                      <input
                        type="date"
                        value={entryDraft.date}
                        onChange={(event) =>
                          setEntryDraft((previous) =>
                            previous
                              ? {
                                  ...previous,
                                  date: event.target.value,
                                }
                              : previous,
                          )
                        }
                      />
                    </label>
                    <label>
                      Engagement
                      <select
                        value={entryDraft.engagementId}
                        onChange={(event) =>
                          setEntryDraft((previous) =>
                            previous
                              ? {
                                  ...previous,
                                  engagementId: event.target.value,
                                  activityId: '',
                                }
                              : previous,
                          )
                        }
                      >
                        <option value="">Uncategorized</option>
                        {engagements.map((engagement) => (
                          <option key={engagement.id} value={engagement.id}>
                            {engagement.code} {engagement.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Activity
                      <select
                        value={entryDraft.activityId}
                        onChange={(event) =>
                          setEntryDraft((previous) =>
                            previous
                              ? {
                                  ...previous,
                                  activityId: event.target.value,
                                }
                              : previous,
                          )
                        }
                      >
                        <option value="">Uncategorized</option>
                        {availableActivities.map((activity) => (
                          <option key={activity.id} value={activity.id}>
                            {activity.code} {activity.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Start
                      <input
                        type="time"
                        step={1800}
                        value={entryDraft.startTime}
                        onChange={(event) =>
                          setEntryDraft((previous) =>
                            previous
                              ? {
                                  ...previous,
                                  startTime: event.target.value,
                                }
                              : previous,
                          )
                        }
                      />
                    </label>
                    <label>
                      End
                      <input
                        type="time"
                        step={1800}
                        value={entryDraft.endTime}
                        onChange={(event) =>
                          setEntryDraft((previous) =>
                            previous
                              ? {
                                  ...previous,
                                  endTime: event.target.value,
                                }
                              : previous,
                          )
                        }
                      />
                    </label>
                    <label>
                      Description
                      <textarea
                        rows={4}
                        value={entryDraft.description}
                        onChange={(event) =>
                          setEntryDraft((previous) =>
                            previous
                              ? {
                                  ...previous,
                                  description: event.target.value,
                                }
                              : previous,
                          )
                        }
                      />
                    </label>
                    <button type="submit" disabled={isBusy}>
                      Save Entry
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => onDeleteTimelineEntry(entryDraft.id)}
                      disabled={isBusy}
                    >
                      Delete Entry
                    </button>
                  </form>
                ) : (
                  <p>Select a timeline block to edit engagement, activity, and timing.</p>
                )}

                {selectedEntry ? (
                  <div className="entry-metadata">
                    <p>
                      Confidence: {(selectedEntry.confidence * 100).toFixed(0)}%
                    </p>
                    <p>Source: {selectedEntry.source}</p>
                    <p>User Submission: {selectedEntry.userSubmissionText || 'Unavailable'}</p>
                    <p>Description: {selectedEntry.description}</p>
                    {selectedEntry.durationDefaulted ? (
                      <p>
                        Duration: Defaulted to {selectedEntry.durationMinutes} minutes (not specified in
                        message).
                      </p>
                    ) : null}
                    {selectedEntry.fallbackSummary ? (
                      <p>Fallback: {selectedEntry.fallbackSummary}</p>
                    ) : null}
                    {selectedEntry.warningFlags.length > 0 ? (
                      <div className="warning-row">
                        {selectedEntry.warningFlags.map((warningType) => (
                          <WarningBadge key={`${selectedEntry.id}-${warningType}`} type={warningType} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </aside>
            </div>
          </section>
        ) : null}

        {activeView === 'codes' ? (
          <section className="panel code-panel">
            <div className="code-forms">
              <form className="stack" onSubmit={onSubmitEngagement}>
                <h2>{engagementForm.id ? 'Edit Engagement' : 'Add Engagement'}</h2>
                <label>
                  Code
                  <input
                    value={engagementForm.code}
                    onChange={(event) =>
                      setEngagementForm((previous) => ({
                        ...previous,
                        code: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  Name
                  <input
                    value={engagementForm.name}
                    onChange={(event) =>
                      setEngagementForm((previous) => ({
                        ...previous,
                        name: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  Client
                  <input
                    value={engagementForm.client}
                    onChange={(event) =>
                      setEngagementForm((previous) => ({
                        ...previous,
                        client: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Engagement Color (optional)
                  <div className="color-input-row">
                    <input
                      type="color"
                      value={engagementFormColorValue ?? TIMELINE_NEUTRAL_COLOR}
                      onChange={(event) =>
                        setEngagementForm((previous) => ({
                          ...previous,
                          colorHex: event.target.value.toUpperCase(),
                        }))
                      }
                      aria-label="Select engagement color"
                    />
                    <input
                      value={engagementForm.colorHex}
                      onChange={(event) =>
                        setEngagementForm((previous) => ({
                          ...previous,
                          colorHex: event.target.value.toUpperCase(),
                        }))
                      }
                      placeholder="#RRGGBB"
                      maxLength={7}
                    />
                  </div>
                </label>
                <div className="color-note-row">
                  <span
                    className="color-chip"
                    style={{ backgroundColor: engagementFormColorValue ?? TIMELINE_NEUTRAL_COLOR }}
                  />
                  <p>Global fallback color for activities in this engagement.</p>
                  <button
                    type="button"
                    className="ghost color-clear-button"
                    onClick={() =>
                      setEngagementForm((previous) => ({
                        ...previous,
                        colorHex: '',
                      }))
                    }
                  >
                    Use Default
                  </button>
                </div>
                <label>
                  Describe when to use this engagement
                  <textarea
                    rows={3}
                    maxLength={500}
                    value={engagementForm.describeWhenToUse}
                    onChange={(event) =>
                      setEngagementForm((previous) => ({
                        ...previous,
                        describeWhenToUse: event.target.value,
                      }))
                    }
                    placeholder="Use this engagement when..."
                  />
                </label>
                <label>
                  Tags / Key Words (comma separated)
                  <input
                    value={engagementForm.tags}
                    onChange={(event) =>
                      setEngagementForm((previous) => ({
                        ...previous,
                        tags: event.target.value,
                      }))
                    }
                  />
                </label>
                <button type="submit" disabled={isBusy}>
                  {engagementForm.id ? 'Update Engagement' : 'Create Engagement'}
                </button>
                {engagementForm.id ? (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setEngagementForm(EMPTY_ENGAGEMENT_FORM)}
                  >
                    Cancel Editing
                  </button>
                ) : null}
              </form>

              <form className="stack" onSubmit={onSubmitActivity}>
                <h2>{activityForm.id ? 'Edit Activity' : 'Add Activity'}</h2>
                <label>
                  Engagement
                  <select
                    value={activityForm.engagementId}
                    onChange={(event) =>
                      setActivityForm((previous) => ({
                        ...previous,
                        engagementId: event.target.value,
                      }))
                    }
                    required
                  >
                    <option value="" disabled>
                      Select engagement
                    </option>
                    {engagements.map((engagement) => (
                      <option key={engagement.id} value={engagement.id}>
                        {engagement.code} {engagement.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Code
                  <input
                    value={activityForm.code}
                    onChange={(event) =>
                      setActivityForm((previous) => ({
                        ...previous,
                        code: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  Name
                  <input
                    value={activityForm.name}
                    onChange={(event) =>
                      setActivityForm((previous) => ({
                        ...previous,
                        name: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  Activity Color (optional)
                  <div className="color-input-row">
                    <input
                      type="color"
                      value={activityFormColorValue ?? selectedEngagementColorValue ?? TIMELINE_NEUTRAL_COLOR}
                      onChange={(event) =>
                        setActivityForm((previous) => ({
                          ...previous,
                          colorHex: event.target.value.toUpperCase(),
                        }))
                      }
                      aria-label="Select activity color"
                    />
                    <input
                      value={activityForm.colorHex}
                      onChange={(event) =>
                        setActivityForm((previous) => ({
                          ...previous,
                          colorHex: event.target.value.toUpperCase(),
                        }))
                      }
                      placeholder="#RRGGBB"
                      maxLength={7}
                    />
                  </div>
                </label>
                <div className="color-note-row">
                  <span
                    className="color-chip"
                    style={{
                      backgroundColor:
                        activityFormColorValue
                        ?? selectedEngagementColorValue
                        ?? TIMELINE_NEUTRAL_COLOR,
                    }}
                  />
                  <p>Activity color overrides engagement color for timeline blocks.</p>
                  <button
                    type="button"
                    className="ghost color-clear-button"
                    onClick={() =>
                      setActivityForm((previous) => ({
                        ...previous,
                        colorHex: '',
                      }))
                    }
                  >
                    Use Default
                  </button>
                </div>
                <label>
                  Describe when to use this activity code
                  <textarea
                    rows={3}
                    maxLength={500}
                    value={activityForm.describeWhenToUse}
                    onChange={(event) =>
                      setActivityForm((previous) => ({
                        ...previous,
                        describeWhenToUse: event.target.value,
                      }))
                    }
                    placeholder="Use this activity code when..."
                  />
                </label>
                <label>
                  Tags / Key Words (comma separated)
                  <input
                    value={activityForm.tags}
                    onChange={(event) =>
                      setActivityForm((previous) => ({
                        ...previous,
                        tags: event.target.value,
                      }))
                    }
                  />
                </label>
                <button type="submit" disabled={isBusy || engagements.length === 0}>
                  {activityForm.id ? 'Update Activity' : 'Create Activity'}
                </button>
                {activityForm.id ? (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      setActivityForm((previous) => ({
                        ...EMPTY_ACTIVITY_FORM,
                        engagementId: previous.engagementId,
                      }))
                    }
                  >
                    Cancel Editing
                  </button>
                ) : null}
              </form>
            </div>

            <div className="code-list">
              {engagements.map((engagement) => {
                const engagementColor = normalizeColorHexInput(engagement.colorHex) ?? TIMELINE_NEUTRAL_COLOR

                return (
                  <article key={engagement.id} className="engagement-card">
                    <header>
                      <div>
                        <h3>
                          {engagement.code} {engagement.name}
                        </h3>
                        <p>{engagement.client ?? 'No client'}</p>
                        <p>
                          When to use:{' '}
                          {engagement.describeWhenToUse ?? 'No usage guidance'}
                        </p>
                        <p>Tags / Key Words: {joinTags(engagement.tags) || 'No tags'}</p>
                        <p className="color-list-row">
                          <span
                            className="color-chip"
                            style={{ backgroundColor: engagementColor }}
                          />
                          Engagement color
                        </p>
                      </div>
                      <div className="row-actions">
                        <button type="button" onClick={() => onEditEngagement(engagement)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => onDeleteEngagement(engagement.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </header>
                    <ul>
                      {engagement.activities.map((activity) => {
                        const activityColor =
                          normalizeColorHexInput(activity.colorHex)
                          ?? normalizeColorHexInput(engagement.colorHex)
                          ?? TIMELINE_NEUTRAL_COLOR

                        return (
                          <li key={activity.id}>
                            <div>
                              <strong>{activity.code} {activity.name}</strong>
                              <span>
                                When to use: {activity.describeWhenToUse ?? 'No usage guidance'}
                              </span>
                              <span>Tags / Key Words: {joinTags(activity.tags) || 'No tags'}</span>
                              <span className="color-list-row">
                                <span
                                  className="color-chip"
                                  style={{ backgroundColor: activityColor }}
                                />
                                {activity.colorHex ? 'Activity color' : 'Inherited from engagement/default'}
                              </span>
                            </div>
                            <div className="row-actions">
                              <button type="button" onClick={() => onEditActivity(activity)}>
                                Edit
                              </button>
                              <button
                                type="button"
                                className="danger"
                                onClick={() => onDeleteActivity(activity.id)}
                              >
                                Delete
                              </button>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </article>
                )
              })}
            </div>
          </section>
        ) : null}

        {activeView === 'settings' ? (
          <section className="panel settings-panel">
            <h2>Settings</h2>
            <form className="stack" onSubmit={onSaveApiKey}>
              <label>
                OpenAI API Key
                <input
                  type="password"
                  value={openAiKey}
                  onChange={(event) => setOpenAiKey(event.target.value)}
                  placeholder="sk-..."
                  required
                />
              </label>
              <button type="submit" disabled={isBusy || openAiKey.trim().length === 0}>
                Save Key to Secure Storage
              </button>
            </form>
            <p>
              Key configured: <strong>{settingsStatus?.hasOpenAiKey ? 'Yes' : 'No'}</strong>
            </p>
            <p>
              Storage health:{' '}
              <strong>{settingsStatus?.storageHealth ?? 'unknown'}</strong>
            </p>
            <p>
              Key source: <strong>{formatKeySource(settingsStatus?.keySource)}</strong>
            </p>
            {settingsStatus?.lastError ? (
              <p className={`alert ${settingsStatus?.statusLevel === 'error' ? 'error' : 'warning'}`}>
                Last key status: {settingsStatus.lastError}
              </p>
            ) : null}
          </section>
        ) : null}

        {activeView === 'diagnostics' ? (
          <section className="panel diagnostics-panel">
            <div className="diagnostics-toolbar">
              <h2>Diagnostics</h2>
              <div className="row-actions">
                <button type="button" onClick={onRefreshDiagnostics} disabled={isBusy}>
                  Refresh
                </button>
                <button type="button" onClick={onCopyDiagnostics} disabled={isBusy}>
                  Copy Diagnostics
                </button>
                <button type="button" onClick={onRepairSuspiciousEntries} disabled={isBusy}>
                  Repair Midnight Entries
                </button>
              </div>
            </div>

            <div className="diagnostics-filters">
              {(['all', 'errors', 'warnings', 'capture', 'settings'] as DiagnosticsFilter[]).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className={diagnosticsFilter === filter ? 'active-filter' : 'ghost'}
                  onClick={() => setDiagnosticsFilter(filter)}
                >
                  {filter}
                </button>
              ))}
            </div>

            <div className="diagnostics-list">
              {diagnosticsEvents.length === 0 ? (
                <p>No diagnostics events found.</p>
              ) : (
                diagnosticsEvents.map((event) => (
                  <article
                    key={event.id}
                    className={`diag-event ${event.status === 'error' ? 'error' : ''} ${event.status === 'warning' ? 'warning' : ''}`}
                  >
                    <p>
                      <strong>{formatDiagnosticsTime(event.timestamp)}</strong> | {event.layer} | {event.eventType}
                    </p>
                    <p>
                      command: {event.command ?? '-'} | status: {event.status} | duration:{' '}
                      {event.durationMs ?? '-'}ms | correlation: <code>{event.correlationId}</code>
                    </p>
                    {event.messageText ? <p>message: {event.messageText}</p> : null}
                    <pre>{event.detailsJson}</pre>
                  </article>
                ))
              )}
            </div>

            {diagnosticsBundleText ? (
              <div className="stack">
                <h3>Latest Diagnostics Bundle</h3>
                <p className="diagnostics-hint">
                  Reproduce the issue once, then use this bundle or Copy Diagnostics to share the latest full context.
                </p>
                <textarea value={diagnosticsBundleText} readOnly rows={10} />
              </div>
            ) : null}
          </section>
        ) : null}
          </div>
        </main>
      </div>
      {timelineContextMenu ? createPortal(
        <div
          ref={timelineContextMenuRef}
          className="timeline-context-menu"
          style={{
            left: `${timelineContextMenu.x}px`,
            top: `${timelineContextMenu.y}px`,
          }}
          role="menu"
          aria-label="Timeline entry actions"
        >
          <button
            type="button"
            className="timeline-context-menu-item danger"
            role="menuitem"
            onClick={() => onDeleteTimelineEntry(timelineContextMenu.entryId)}
            disabled={isBusy}
          >
            Delete Entry
          </button>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

function MiniCalendar({
  selectedDate,
  visibleMonth,
  todayDate,
  daysWithEntries,
  isLoading,
  errorMessage,
  onVisibleMonthChange,
  onSelectDate,
}: MiniCalendarProps) {
  const monthLabel = useMemo(() => formatMonthHeading(visibleMonth), [visibleMonth])
  const dayCells = useMemo(() => buildCalendarDayCells(visibleMonth), [visibleMonth])

  return (
    <div className="mini-calendar" aria-busy={isLoading}>
      <div className="mini-calendar-nav">
        <button
          type="button"
          className="ghost mini-calendar-arrow"
          onClick={() => onVisibleMonthChange(shiftMonthKey(visibleMonth, -1))}
          aria-label={`Show ${formatMonthHeading(shiftMonthKey(visibleMonth, -1))}`}
        >
          &#8249;
        </button>
        <p className="mini-calendar-title" aria-live="polite">
          {monthLabel}
        </p>
        <button
          type="button"
          className="ghost mini-calendar-arrow"
          onClick={() => onVisibleMonthChange(shiftMonthKey(visibleMonth, 1))}
          aria-label={`Show ${formatMonthHeading(shiftMonthKey(visibleMonth, 1))}`}
        >
          &#8250;
        </button>
      </div>

      <div className="mini-calendar-weekdays" aria-hidden="true">
        {WEEKDAY_LABELS.map((label, index) => (
          <span key={`${visibleMonth}-${label}-${index}`}>{label}</span>
        ))}
      </div>

      <div className="mini-calendar-grid" role="grid" aria-label={`${monthLabel} calendar`}>
        {dayCells.map((cell) => {
          const isSelected = cell.date === selectedDate
          const isToday = cell.date === todayDate
          const hasEntries = daysWithEntries.has(cell.date)
          const classes = [
            'mini-calendar-day',
            cell.isCurrentMonth ? 'current-month' : 'outside-month',
            isSelected ? 'is-selected' : '',
            isToday ? 'is-today' : '',
            hasEntries ? 'has-entries' : '',
          ]
            .filter(Boolean)
            .join(' ')

          return (
            <button
              type="button"
              key={cell.date}
              className={classes}
              role="gridcell"
              aria-pressed={isSelected}
              aria-label={formatCalendarDayAriaLabel(cell.date, {
                isSelected,
                isToday,
                hasEntries,
              })}
              onClick={() => onSelectDate(cell.date)}
            >
              <span>{cell.dayOfMonth}</span>
            </button>
          )
        })}
      </div>

      {errorMessage ? <p className="mini-calendar-error">{errorMessage}</p> : null}
    </div>
  )
}

function WarningBadge({ type }: { type: WarningType }) {
  const label =
    type === 'low_confidence'
      ? 'Low Confidence'
      : type === 'overlap'
        ? 'Overlap'
        : 'Unmatched'

  return <span className={`warning-badge ${type}`}>{label}</span>
}

function formatDiagnosticsTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString()
}

function formatLocalTime(value: Date): string {
  const hours = `${value.getHours()}`.padStart(2, '0')
  const minutes = `${value.getMinutes()}`.padStart(2, '0')
  return `${hours}:${minutes}`
}

function formatKeySource(value: SettingsStatus['keySource'] | undefined): string {
  if (value === 'keyring') {
    return 'OS keyring'
  }

  if (value === 'session_cache') {
    return 'In-memory session cache'
  }

  if (value === 'none') {
    return 'None'
  }

  return 'unknown'
}

function extractErrorMessage(error: unknown): string {
  if (isAppCommandError(error)) {
    return error.message
  }

  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  return 'Unknown error'
}

function formatCodesMutationError(error: unknown): string {
  const rawMessage = extractErrorMessage(error).trim()
  const normalized = rawMessage.toLowerCase()

  if (normalized.includes('unique constraint failed: engagements.code')) {
    return 'This engagement code is already in use. Enter a different engagement code.'
  }

  if (
    normalized.includes('unique constraint failed: activities.engagement_id')
    && normalized.includes('activities.code')
  ) {
    return 'This activity code already exists for the selected engagement. Enter a different activity code.'
  }

  if (normalized.includes('engagement code and name are required')) {
    return 'Engagement code and name are required.'
  }

  if (normalized.includes('activity engagement, code, and name are required')) {
    return 'Select an engagement and enter both activity code and activity name.'
  }

  if (
    normalized.includes('invalid input: colorhex must be a valid #rrggbb value')
    || normalized.includes('engagement color must be a valid #rrggbb value')
    || normalized.includes('activity color must be a valid #rrggbb value')
  ) {
    return 'Color must be a valid hex value like #1A2B3C.'
  }

  if (normalized.includes('describewhentouse must be')) {
    return '"Describe when to use" must be 500 characters or fewer.'
  }

  if (normalized.includes('foreign key constraint failed')) {
    return 'The selected engagement is no longer available. Refresh and try again.'
  }

  if (normalized.includes('database error:')) {
    return 'We could not save your changes due to a database error. Please try again.'
  }

  return 'We could not save your changes. Please review your input and try again.'
}

function formatTimelineRangeEndLabel(minute: number): string {
  if (minute >= MINUTES_IN_DAY) {
    return '12:00 AM'
  }

  return minuteToLabel(minute)
}

function monthKeyFromDate(date: string): string {
  return date.slice(0, 7)
}

function shiftMonthKey(monthKey: string, delta: number): string {
  const [yearToken, monthToken] = monthKey.split('-')
  const year = Number(yearToken)
  const monthIndex = Number(monthToken) - 1
  const shifted = new Date(year, monthIndex + delta, 1)
  return `${shifted.getFullYear()}-${`${shifted.getMonth() + 1}`.padStart(2, '0')}`
}

function formatMonthHeading(monthKey: string): string {
  const [yearToken, monthToken] = monthKey.split('-')
  const year = Number(yearToken)
  const monthIndex = Number(monthToken) - 1
  const value = new Date(year, monthIndex, 1)

  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(value)
}

function buildCalendarDayCells(monthKey: string): CalendarDayCell[] {
  const [yearToken, monthToken] = monthKey.split('-')
  const year = Number(yearToken)
  const monthIndex = Number(monthToken) - 1

  const firstDayOfMonth = new Date(year, monthIndex, 1)
  const gridStart = new Date(year, monthIndex, 1 - firstDayOfMonth.getDay())
  const cells: CalendarDayCell[] = []

  for (let index = 0; index < 42; index += 1) {
    const currentDate = new Date(gridStart)
    currentDate.setDate(gridStart.getDate() + index)

    cells.push({
      date: formatDate(currentDate),
      dayOfMonth: currentDate.getDate(),
      isCurrentMonth:
        currentDate.getFullYear() === year
        && currentDate.getMonth() === monthIndex,
    })
  }

  return cells
}

function formatCalendarDayAriaLabel(
  date: string,
  state: { isSelected: boolean; isToday: boolean; hasEntries: boolean },
): string {
  const value = new Date(`${date}T00:00:00`)
  const parts = [
    new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(value),
  ]

  if (state.isSelected) {
    parts.push('selected')
  }

  if (state.isToday) {
    parts.push('today')
  }

  if (state.hasEntries) {
    parts.push('has entries')
  }

  return parts.join(', ')
}

function positionTimelineEntries(
  entries: TimelineEntry[],
  timelineWindow: TimelineWindow,
): PositionedTimelineEntry[] {
  const clippedEntries: ClippedTimelineEntry[] = entries
    .map((entry) => {
      const clippedStartMinute = Math.max(entry.startMinute, timelineWindow.startMinute)
      const clippedEndMinute = Math.min(entry.endMinute, timelineWindow.endMinute)

      return {
        entry,
        clippedStartMinute,
        clippedEndMinute,
      }
    })
    .filter((entry) => entry.clippedEndMinute > entry.clippedStartMinute)
    .sort((a, b) => {
      if (a.clippedStartMinute !== b.clippedStartMinute) {
        return a.clippedStartMinute - b.clippedStartMinute
      }

      if (a.clippedEndMinute !== b.clippedEndMinute) {
        return a.clippedEndMinute - b.clippedEndMinute
      }

      return a.entry.id.localeCompare(b.entry.id)
    })

  if (clippedEntries.length === 0) {
    return []
  }

  type LaneEntry = ClippedTimelineEntry & { laneIndex: number }

  const groups: LaneEntry[][] = []
  let activeLanes: Array<{ laneIndex: number; endMinute: number }> = []
  let currentGroup: LaneEntry[] = []

  for (const clippedEntry of clippedEntries) {
    activeLanes = activeLanes.filter(
      (lane) => lane.endMinute > clippedEntry.clippedStartMinute,
    )

    if (activeLanes.length === 0 && currentGroup.length > 0) {
      groups.push(currentGroup)
      currentGroup = []
    }

    const occupiedLanes = new Set(activeLanes.map((lane) => lane.laneIndex))
    let laneIndex = 0
    while (occupiedLanes.has(laneIndex)) {
      laneIndex += 1
    }

    activeLanes.push({
      laneIndex,
      endMinute: clippedEntry.clippedEndMinute,
    })

    currentGroup.push({
      ...clippedEntry,
      laneIndex,
    })
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup)
  }

  const positionedEntries: PositionedTimelineEntry[] = []

  for (const group of groups) {
    const laneCount = Math.max(...group.map((entry) => entry.laneIndex)) + 1
    const laneGapPercent = laneCount > 1 ? TIMELINE_OVERLAP_GAP_PERCENT : 0
    const totalGapPercent = laneGapPercent * Math.max(0, laneCount - 1)
    const widthPercent = (100 - totalGapPercent) / laneCount

    for (const groupEntry of group) {
      positionedEntries.push({
        ...groupEntry,
        laneCount,
        top:
          TIMELINE_CANVAS_TOP_PADDING
          + (groupEntry.clippedStartMinute - timelineWindow.startMinute)
          * PIXELS_PER_MINUTE,
        height: Math.max(
          (groupEntry.clippedEndMinute - groupEntry.clippedStartMinute)
          * PIXELS_PER_MINUTE,
          30,
        ),
        leftPercent: groupEntry.laneIndex * (widthPercent + laneGapPercent),
        widthPercent,
      })
    }
  }

  return positionedEntries
}

function normalizeColorHexInput(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  const normalized = value.trim().toUpperCase()
  if (normalized.length === 0) {
    return null
  }

  if (!/^#[0-9A-F]{6}$/.test(normalized)) {
    return null
  }

  return normalized
}

function resolveTimelineBlockColor(
  entry: TimelineEntry,
  activityColorById: Map<string, string | null>,
  engagementColorById: Map<string, string | null>,
): string {
  if (entry.activityId) {
    const activityColor = activityColorById.get(entry.activityId)
    if (activityColor) {
      return activityColor
    }
  }

  if (entry.engagementId) {
    const engagementColor = engagementColorById.get(entry.engagementId)
    if (engagementColor) {
      return engagementColor
    }
  }

  return TIMELINE_NEUTRAL_COLOR
}

function colorForBackground(backgroundHex: string): string {
  const normalized = normalizeColorHexInput(backgroundHex) ?? TIMELINE_NEUTRAL_COLOR
  const red = Number.parseInt(normalized.slice(1, 3), 16)
  const green = Number.parseInt(normalized.slice(3, 5), 16)
  const blue = Number.parseInt(normalized.slice(5, 7), 16)
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255

  return luminance > 0.62 ? '#0F172A' : '#F8FAFC'
}

function buildTimelineBlockLabel(
  entry: TimelineEntry,
  widthPercent: number,
  blockHeight: number,
): TimelineLabel {
  const engagementCode = entry.engagementCode ?? 'UNCAT'
  const activityCode = entry.activityCode ?? 'UNCAT'
  const activityName = entry.activityName?.trim() ?? activityCode
  const activityDisplaySegment =
    activityName.toUpperCase() === activityCode.toUpperCase()
      ? activityCode
      : `${activityCode} ${activityName}`
  const warningCount = entry.warningFlags.length
  const warningLong = warningCount > 0
    ? `${warningCount} warning${warningCount === 1 ? '' : 's'}`
    : ''
  const warningCompact = warningCount > 0 ? `${warningCount}w` : ''

  const fullLabelBase = `${engagementCode} | ${activityDisplaySegment}`
  const fullLabel = warningLong ? `${fullLabelBase} | ${warningLong}` : fullLabelBase

  if (widthPercent < 36 || blockHeight < 28) {
    const compactLabel = warningCompact ? `${activityCode} | ${warningCompact}` : activityCode
    return {
      label: compactLabel,
      fullLabel,
      tier: 3,
    }
  }

  if (widthPercent < 58 || blockHeight < 38) {
    const compactLabel = warningCompact
      ? `${engagementCode} | ${activityCode} | ${warningCompact}`
      : `${engagementCode} | ${activityCode}`
    return {
      label: compactLabel,
      fullLabel,
      tier: 2,
    }
  }

  return {
    label: fullLabel,
    fullLabel,
    tier: 1,
  }
}

function clampTimelineContextMenuPosition(clientX: number, clientY: number): { x: number; y: number } {
  const viewportPadding = 8
  const menuWidth = 170
  const menuHeight = 46
  const maxX = Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding)
  const maxY = Math.max(viewportPadding, window.innerHeight - menuHeight - viewportPadding)

  return {
    x: Math.min(Math.max(clientX, viewportPadding), maxX),
    y: Math.min(Math.max(clientY, viewportPadding), maxY),
  }
}

export default App

