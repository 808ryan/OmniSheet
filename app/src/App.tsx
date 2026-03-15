import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
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
  isAppCommandError,
  settingsGetStatus,
  settingsSetOpenAiKey,
  settingsSetOpenAiModel,
  summaryExportWeeklyExcel,
  timelineDeleteEntry,
  timelineListForDate,
  timelineMonthSummary,
  timelineWeeklySummary,
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
  OpenAiModelId,
  SettingsStatus,
  TimelineDaySummary,
  TimelineEntry,
  TimelineWeeklySummary,
  TimelineWeeklySummaryNote,
  WarningType,
} from './lib/types'
import deleteIcon from './assets/icons/delete.svg'
import editIcon from './assets/icons/edit.svg'
import './App.css'

type View = 'timeline' | 'codes' | 'settings' | 'diagnostics' | 'summary'
type DiagnosticsFilter = 'all' | 'errors' | 'warnings' | 'capture' | 'settings'
type MonthSummaryCache = Record<string, TimelineDaySummary[]>
type CodeEditorSurface =
  | 'create-engagement'
  | 'edit-engagement'
  | 'create-activity'
  | 'edit-activity'

type SubmissionQueueItemState = 'pending' | 'running' | 'success' | 'error'

interface SubmissionQueueItem {
  id: string
  rawText: string
  submittedAtMs: number
  requestedOpenAiModel: OpenAiModelId
  clientTimestampIso: string
  clientLocalDate: string
  clientLocalTime: string
  clientUtcOffsetMinutes: number
  timezone: string
  state: SubmissionQueueItemState
  statusMessage: string
  correlationId?: string
  createdEntryCount?: number
  completedAtMs?: number
  completedDurationMs?: number
  modelUsed?: OpenAiModelId
  modelUsedLabel?: string
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
  preserveEndOfDay: boolean
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
  highlightedDates: Set<string>
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

interface TimelineHeaderDate {
  monthDay: string
  year: string
  weekday: string
}

interface TimelineContextMenuState {
  entryId: string
  x: number
  y: number
}

interface TimelineToast {
  id: number
  kind: 'success' | 'error'
  message: string
}

interface TimelineDragState {
  entryId: string
  pointerId: number
  initialClientY: number
  lockedLaneIndex: number
  pointerOffsetMinutes: number
  durationMinutes: number
  originalStartMinute: number
  originalEndMinute: number
  previewStartMinute: number
  previewEndMinute: number
  isDragging: boolean
}

interface SummaryNotesModalState {
  rowIndex: number
  dayIndex: number
}

interface PositionTimelineEntriesOptions {
  lockedEntryId?: string
  lockedLaneIndex?: number
  preferredLaneByEntryId?: Map<string, number>
  preferredLaneOrder?: string[]
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

function getDefaultActivityEngagementId(engagements: Engagement[]): string {
  return engagements[0]?.id ?? ''
}

function buildEmptyActivityForm(engagementId: string): ActivityFormState {
  return {
    ...EMPTY_ACTIVITY_FORM,
    engagementId,
  }
}

const MINUTES_IN_DAY = 24 * 60
const HOUR_IN_MINUTES = 60
const PIXELS_PER_MINUTE = 1
const TIMELINE_CANVAS_TOP_PADDING = 18
const TIMELINE_CANVAS_BOTTOM_PADDING = 20
const TIMELINE_OVERLAP_GAP_PERCENT = 1.2
const TIMELINE_NEUTRAL_COLOR = '#6F7B89'
const TIMELINE_ACCENT_BRIGHTNESS_THRESHOLD = 0.8
const TIMELINE_ACCENT_DARKEN_FACTOR = 0.72
const TIMELINE_ACCENT_SATURATION_BOOST = 1.18
const TIMELINE_ACCENT_LIGHTEN_RATIO = 0.24
const TIMELINE_DRAG_SNAP_MINUTES = 15
const TIMELINE_DRAG_ACTIVATION_PX = 4
const FULL_DAY_TIMELINE_WINDOW: TimelineWindow = {
  startMinute: 0,
  endMinute: MINUTES_IN_DAY,
}
const END_OF_DAY_INPUT_SENTINEL = '23:59'
const MAX_CONCURRENT_SUBMISSIONS = 5
const MAX_FINISHED_QUEUE_HISTORY = 10
const DEFAULT_OPENAI_MODEL: OpenAiModelId = 'gpt-5-nano'
const SEGMENTED_VIEWS: Array<{ id: View; label: string }> = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'codes', label: 'Codes' },
  { id: 'settings', label: 'Settings' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'summary', label: 'Summary View' },
]
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const
const SUMMARY_DAY_NAMES = [
  'Saturday',
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
] as const

interface ResponsiveCodeTagListProps {
  tags: string[]
  itemKeyPrefix: string
}

function ResponsiveCodeTagList({ tags, itemKeyPrefix }: ResponsiveCodeTagListProps) {
  const normalizedTags = useMemo(() => normalizeCodeTags(tags), [tags])
  const [visibleCount, setVisibleCount] = useState(normalizedTags.length)
  const containerRef = useRef<HTMLSpanElement | null>(null)
  const measurementRowRef = useRef<HTMLSpanElement | null>(null)
  const moreMeasurementRef = useRef<HTMLSpanElement | null>(null)
  const tagMeasurementRefs = useRef<Array<HTMLSpanElement | null>>([])
  const measurementFrameRef = useRef<number | null>(null)

  const measureVisibleCount = useCallback(() => {
    const container = containerRef.current
    const measurementRow = measurementRowRef.current
    const moreMeasurement = moreMeasurementRef.current

    if (!container || !measurementRow || !moreMeasurement) {
      return
    }

    const availableWidth = container.clientWidth
    if (availableWidth <= 0) {
      setVisibleCount(0)
      return
    }

    const computedStyles = window.getComputedStyle(measurementRow)
    const gapValue = computedStyles.columnGap || computedStyles.gap || '0'
    const gap = Number.parseFloat(gapValue) || 0
    const tagWidths = normalizedTags.map(
      (_, index) => tagMeasurementRefs.current[index]?.offsetWidth ?? 0,
    )
    const prefixWidths = [0]

    for (const width of tagWidths) {
      prefixWidths.push(prefixWidths[prefixWidths.length - 1] + width)
    }

    const allTagsWidth = prefixWidths[prefixWidths.length - 1] + Math.max(0, tagWidths.length - 1) * gap
    if (allTagsWidth <= availableWidth) {
      setVisibleCount((previous) => (previous === normalizedTags.length ? previous : normalizedTags.length))
      return
    }

    let nextVisibleCount = 0

    for (let candidateCount = normalizedTags.length - 1; candidateCount >= 0; candidateCount -= 1) {
      const hiddenCount = normalizedTags.length - candidateCount
      moreMeasurement.textContent = `+${hiddenCount}`
      const moreWidth = moreMeasurement.offsetWidth
      const visibleWidth = prefixWidths[candidateCount]
      const totalItemCount = candidateCount + 1
      const totalGapWidth = totalItemCount > 1 ? (totalItemCount - 1) * gap : 0

      if (visibleWidth + moreWidth + totalGapWidth <= availableWidth) {
        nextVisibleCount = candidateCount
        break
      }
    }

    setVisibleCount((previous) => (previous === nextVisibleCount ? previous : nextVisibleCount))
  }, [normalizedTags])

  useLayoutEffect(() => {
    if (normalizedTags.length === 0) {
      return
    }

    const scheduleMeasurement = () => {
      if (measurementFrameRef.current !== null) {
        window.cancelAnimationFrame(measurementFrameRef.current)
      }

      measurementFrameRef.current = window.requestAnimationFrame(() => {
        measurementFrameRef.current = null
        measureVisibleCount()
      })
    }

    scheduleMeasurement()

    const container = containerRef.current
    let resizeObserver: ResizeObserver | null = null
    const handleWindowResize = () => {
      scheduleMeasurement()
    }

    if (container && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        scheduleMeasurement()
      })
      resizeObserver.observe(container)
    } else {
      window.addEventListener('resize', handleWindowResize)
    }

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', handleWindowResize)
      if (measurementFrameRef.current !== null) {
        window.cancelAnimationFrame(measurementFrameRef.current)
      }
    }
  }, [measureVisibleCount, normalizedTags.length])

  if (normalizedTags.length === 0) {
    return null
  }

  const safeVisibleCount = Math.max(0, Math.min(visibleCount, normalizedTags.length))
  const hiddenTagCount = Math.max(0, normalizedTags.length - safeVisibleCount)
  const visibleTags = normalizedTags.slice(0, safeVisibleCount)

  return (
    <span className="responsive-code-tag-list">
      <span ref={containerRef} className="code-tag-list">
        {visibleTags.map((tag, index) => (
          <span key={`${itemKeyPrefix}-${tag}-${index}`} className="code-tag">
            {tag}
          </span>
        ))}
        {hiddenTagCount > 0 ? <span className="code-tag code-tag-more">+{hiddenTagCount}</span> : null}
      </span>
      <span className="code-tag-measurement" aria-hidden="true">
        <span ref={measurementRowRef} className="code-tag-list code-tag-list-measurement">
          {normalizedTags.map((tag, index) => (
            <span
              key={`${itemKeyPrefix}-measure-${tag}-${index}`}
              ref={(node) => {
                tagMeasurementRefs.current[index] = node
              }}
              className="code-tag"
            >
              {tag}
            </span>
          ))}
          <span ref={moreMeasurementRef} className="code-tag code-tag-more">
            +{normalizedTags.length}
          </span>
        </span>
      </span>
    </span>
  )
}

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
  const [selectedOpenAiModelDraft, setSelectedOpenAiModelDraft] =
    useState<OpenAiModelId>(DEFAULT_OPENAI_MODEL)

  const [engagements, setEngagements] = useState<Engagement[]>([])
  const [codeEditorSurface, setCodeEditorSurface] = useState<CodeEditorSurface | null>(null)
  const [editorActivationKey, setEditorActivationKey] = useState(0)
  const [expandedEngagementId, setExpandedEngagementId] = useState<string | null>(null)
  const [engagementForm, setEngagementForm] =
    useState<EngagementFormState>(EMPTY_ENGAGEMENT_FORM)
  const [activityForm, setActivityForm] = useState<ActivityFormState>(EMPTY_ACTIVITY_FORM)

  const [captureMessage, setCaptureMessage] = useState('')
  const [submissionQueue, setSubmissionQueue] = useState<SubmissionQueueItem[]>([])
  const [isSubmissionQueueOpen, setIsSubmissionQueueOpen] = useState(false)

  const [selectedDate, setSelectedDate] = useState(todayDate)
  const [visibleMonth, setVisibleMonth] = useState(() => monthKeyFromDate(todayDate))
  const [timelineEntries, setTimelineEntries] = useState<TimelineEntry[]>([])
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [entryDraft, setEntryDraft] = useState<EntryDraft | null>(null)
  const [timelineContextMenu, setTimelineContextMenu] = useState<TimelineContextMenuState | null>(null)
  const [isTimelineDeleteBusy, setIsTimelineDeleteBusy] = useState(false)
  const [timelineToast, setTimelineToast] = useState<TimelineToast | null>(null)
  const [timelineDragState, setTimelineDragState] = useState<TimelineDragState | null>(null)
  const [timelineLanePreferences, setTimelineLanePreferences] = useState(() => ({
    byEntryId: new Map<string, number>(),
    order: [] as string[],
  }))
  const [monthSummaryCache, setMonthSummaryCache] = useState<MonthSummaryCache>({})
  const [monthSummaryLoadingMonth, setMonthSummaryLoadingMonth] = useState<string | null>(null)
  const [monthSummaryError, setMonthSummaryError] = useState<string | null>(null)
  const codeFormsBodyRef = useRef<HTMLDivElement | null>(null)
  const engagementNameInputRef = useRef<HTMLInputElement | null>(null)
  const activityEngagementSelectRef = useRef<HTMLSelectElement | null>(null)
  const timelineGridRef = useRef<HTMLDivElement | null>(null)
  const timelineContextMenuRef = useRef<HTMLDivElement | null>(null)
  const hasInitializedRef = useRef(false)
  const lastLoadedTimelineDateRef = useRef<string | null>(null)
  const pendingAutoCenterDateRef = useRef<string | null>(todayDate)
  const selectedDateRef = useRef(selectedDate)
  const timelineToastIdRef = useRef(0)
  const timelineDragStateRef = useRef<TimelineDragState | null>(null)
  const timelineEntriesRef = useRef<TimelineEntry[]>([])
  const suppressTimelineClickRef = useRef(false)
  const inFlightSubmissionIdsRef = useRef<Set<string>>(new Set())
  const [diagnosticsFilter, setDiagnosticsFilter] = useState<DiagnosticsFilter>('all')
  const [diagnosticsEvents, setDiagnosticsEvents] = useState<DiagnosticsEvent[]>([])
  const [diagnosticsBundleText, setDiagnosticsBundleText] = useState('')
  const [weeklySummary, setWeeklySummary] = useState<TimelineWeeklySummary | null>(null)
  const [isWeeklySummaryLoading, setIsWeeklySummaryLoading] = useState(false)
  const [weeklySummaryError, setWeeklySummaryError] = useState<string | null>(null)
  const [isSummaryExporting, setIsSummaryExporting] = useState(false)
  const [summaryNotesModal, setSummaryNotesModal] = useState<SummaryNotesModalState | null>(null)
  const summaryNotesModalRef = useRef<HTMLDivElement | null>(null)

  const selectedEntry = useMemo(
    () => timelineEntries.find((entry) => entry.id === selectedEntryId) ?? null,
    [selectedEntryId, timelineEntries],
  )
  const selectedEntryHasMultiEventSource = (selectedEntry?.sourceMessageEntryCount ?? 0) > 1
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
  const summaryWeekHighlightedDates = useMemo(() => {
    if (activeView !== 'summary' || !weeklySummary) {
      return new Set<string>()
    }

    return new Set(weeklySummary.days.map((day) => day.date))
  }, [activeView, weeklySummary])
  const selectedSummaryNotesContext = useMemo(() => {
    if (!weeklySummary || !summaryNotesModal) {
      return null
    }

    const row = weeklySummary.rows[summaryNotesModal.rowIndex]
    const day = weeklySummary.days[summaryNotesModal.dayIndex]
    if (!row || !day) {
      return null
    }

    const cell = row.cells[summaryNotesModal.dayIndex]
    if (!cell || cell.notes.length === 0) {
      return null
    }

    return {
      row,
      day,
      dayIndex: summaryNotesModal.dayIndex,
      notes: cell.notes,
    }
  }, [summaryNotesModal, weeklySummary])
  const submissionQueueDisplayItems = useMemo(() => {
    const processing = submissionQueue.filter((item) => item.state === 'running')
    const pending = submissionQueue.filter((item) => item.state === 'pending')
    const finished = submissionQueue
      .filter((item) => item.state === 'success' || item.state === 'error')
      .sort(
        (left, right) =>
          (right.completedAtMs ?? right.submittedAtMs) - (left.completedAtMs ?? left.submittedAtMs),
      )

    return [...processing, ...pending, ...finished]
  }, [submissionQueue])

  const timelineWindow = FULL_DAY_TIMELINE_WINDOW
  const timelineHeaderDate = useMemo(
    () => formatTimelineHeaderDate(selectedDate),
    [selectedDate],
  )

  const timelineWindowMinutes = timelineWindow.endMinute - timelineWindow.startMinute
  const timelineCanvasHeight = (
    timelineWindowMinutes * PIXELS_PER_MINUTE
      + TIMELINE_CANVAS_TOP_PADDING
      + TIMELINE_CANVAS_BOTTOM_PADDING
  )
  const timelinePositioningPreferences = useMemo(
    () => ({
      preferredLaneByEntryId: timelineLanePreferences.byEntryId,
      preferredLaneOrder: timelineLanePreferences.order,
    }),
    [timelineLanePreferences],
  )
  const baselinePositionedTimelineEntries = useMemo(
    () => positionTimelineEntries(
      timelineEntries,
      timelineWindow,
      timelinePositioningPreferences,
    ),
    [timelineEntries, timelinePositioningPreferences, timelineWindow],
  )
  const timelineEntriesForLayout = useMemo(
    () => applyDragPreviewToTimelineEntries(timelineEntries, timelineDragState),
    [timelineDragState, timelineEntries],
  )
  const previewPositionedTimelineEntries = useMemo(
    () => positionTimelineEntries(
      timelineEntriesForLayout,
      timelineWindow,
      {
        ...timelinePositioningPreferences,
        ...(timelineDragState?.isDragging
          ? {
            lockedEntryId: timelineDragState.entryId,
            lockedLaneIndex: timelineDragState.lockedLaneIndex,
          }
          : {}),
      },
    ),
    [
      timelineDragState,
      timelineEntriesForLayout,
      timelinePositioningPreferences,
      timelineWindow,
    ],
  )
  const draggedEntryOriginPosition = useMemo(() => {
    if (!timelineDragState?.isDragging) {
      return null
    }

    return baselinePositionedTimelineEntries.find(
      (positionedEntry) => positionedEntry.entry.id === timelineDragState.entryId,
    ) ?? null
  }, [baselinePositionedTimelineEntries, timelineDragState])

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
  const isEngagementEditorOpen =
    codeEditorSurface === 'create-engagement' || codeEditorSurface === 'edit-engagement'
  const isActivityEditorOpen =
    codeEditorSurface === 'create-activity' || codeEditorSurface === 'edit-activity'
  const isEditingEngagement = codeEditorSurface === 'edit-engagement'
  const isEditingActivity = codeEditorSurface === 'edit-activity'
  const canCreateActivity = engagements.length > 0

  const engagementFormColorValue = normalizeColorHexInput(engagementForm.colorHex)
  const activityFormColorValue = normalizeColorHexInput(activityForm.colorHex)
  const selectedEngagementColorValue = normalizeColorHexInput(selectedActivityEngagement?.colorHex)

  useEffect(() => {
    if (!expandedEngagementId) {
      return
    }

    const isExpandedEngagementPresent = engagements.some(
      (engagement) => engagement.id === expandedEngagementId,
    )
    if (!isExpandedEngagementPresent) {
      setExpandedEngagementId(null)
    }
  }, [engagements, expandedEngagementId])

  const openCreateEngagementEditor = useCallback(() => {
    setEngagementForm(EMPTY_ENGAGEMENT_FORM)
    setCodeEditorSurface('create-engagement')
    setEditorActivationKey((previous) => previous + 1)
  }, [])

  const openCreateActivityEditor = useCallback(() => {
    if (engagements.length === 0) {
      return
    }

    setActivityForm(buildEmptyActivityForm(getDefaultActivityEngagementId(engagements)))
    setCodeEditorSurface('create-activity')
    setEditorActivationKey((previous) => previous + 1)
  }, [engagements])

  const closeCodeEditor = useCallback(() => {
    if (isEngagementEditorOpen) {
      setEngagementForm(EMPTY_ENGAGEMENT_FORM)
    }

    if (isActivityEditorOpen) {
      setActivityForm(buildEmptyActivityForm(getDefaultActivityEngagementId(engagements)))
    }

    setCodeEditorSurface(null)
  }, [engagements, isActivityEditorOpen, isEngagementEditorOpen])

  const toggleEngagementEditor = useCallback(() => {
    if (isEngagementEditorOpen) {
      closeCodeEditor()
      return
    }

    openCreateEngagementEditor()
  }, [closeCodeEditor, isEngagementEditorOpen, openCreateEngagementEditor])

  const toggleActivityEditor = useCallback(() => {
    if (isActivityEditorOpen) {
      closeCodeEditor()
      return
    }

    openCreateActivityEditor()
  }, [closeCodeEditor, isActivityEditorOpen, openCreateActivityEditor])

  useEffect(() => {
    if (!codeEditorSurface) {
      return
    }

    if (codeFormsBodyRef.current) {
      codeFormsBodyRef.current.scrollTop = 0
    }

    const targetInput = isActivityEditorOpen
      ? activityEngagementSelectRef.current
      : engagementNameInputRef.current

    if (!targetInput) {
      return
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      targetInput.focus()
    })

    return () => {
      window.cancelAnimationFrame(animationFrameId)
    }
  }, [codeEditorSurface, editorActivationKey, isActivityEditorOpen])

  useEffect(() => {
    if (isEditingEngagement && engagementForm.id) {
      const engagementStillExists = engagements.some((engagement) => engagement.id === engagementForm.id)
      if (!engagementStillExists) {
        setEngagementForm(EMPTY_ENGAGEMENT_FORM)
        setCodeEditorSurface(null)
      }
      return
    }

    if (!isActivityEditorOpen) {
      return
    }

    if (engagements.length === 0) {
      setActivityForm(EMPTY_ACTIVITY_FORM)
      setCodeEditorSurface(null)
      return
    }

    const hasSelectedEngagement = engagements.some(
      (engagement) => engagement.id === activityForm.engagementId,
    )

    if (isEditingActivity && activityForm.id) {
      const activityStillExists = engagements.some((engagement) =>
        engagement.activities.some((activity) => activity.id === activityForm.id),
      )

      if (!activityStillExists || !hasSelectedEngagement) {
        setActivityForm(buildEmptyActivityForm(getDefaultActivityEngagementId(engagements)))
        setCodeEditorSurface(null)
      }

      return
    }

    if (!hasSelectedEngagement) {
      const defaultEngagementId = getDefaultActivityEngagementId(engagements)
      setActivityForm((previous) => (
        previous.engagementId === defaultEngagementId
          ? previous
          : {
              ...previous,
              engagementId: defaultEngagementId,
            }
      ))
    }
  }, [
    activityForm.engagementId,
    activityForm.id,
    codeEditorSurface,
    engagementForm.id,
    engagements,
    isActivityEditorOpen,
    isEditingActivity,
    isEditingEngagement,
  ])

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
    setSelectedOpenAiModelDraft(status.selectedOpenAiModel)
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

  const loadWeeklySummary = useCallback(async (date: string) => {
    const summary = await timelineWeeklySummary({ date })
    setWeeklySummary(summary)
    return summary
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
    if (!tauriRuntime || !hasInitializedRef.current || activeView !== 'summary') {
      return
    }

    let cancelled = false

    void (async () => {
      try {
        setIsWeeklySummaryLoading(true)
        setWeeklySummaryError(null)
        await loadWeeklySummary(selectedDate)
      } catch (error) {
        if (cancelled) {
          return
        }
        if (isAppCommandError(error)) {
          setWeeklySummaryError(
            `${error.message} (command: ${error.command}, correlationId: ${error.correlationId})`,
          )
        } else {
          setWeeklySummaryError((error as Error).message)
        }
      } finally {
        if (!cancelled) {
          setIsWeeklySummaryLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeView, loadWeeklySummary, selectedDate, tauriRuntime])

  useEffect(() => {
    if (activeView !== 'timeline' && timelineContextMenu) {
      setTimelineContextMenu(null)
    }
  }, [activeView, timelineContextMenu])

  useEffect(() => {
    if (activeView !== 'summary' && summaryNotesModal) {
      setSummaryNotesModal(null)
    }
  }, [activeView, summaryNotesModal])

  useEffect(() => {
    if (!summaryNotesModal) {
      return
    }

    if (!selectedSummaryNotesContext) {
      setSummaryNotesModal(null)
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSummaryNotesModal(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [selectedSummaryNotesContext, summaryNotesModal])

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

    if (pendingAutoCenterDateRef.current !== selectedDate) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      if (baselinePositionedTimelineEntries.length === 0) {
        grid.scrollTop = 0
        pendingAutoCenterDateRef.current = null
        return
      }

      const earliestEntry = baselinePositionedTimelineEntries.reduce((earliest, current) =>
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
      pendingAutoCenterDateRef.current = null
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [activeView, baselinePositionedTimelineEntries, selectedDate])

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

  useEffect(() => {
    if (!timelineToast) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setTimelineToast(null)
    }, 4000)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [timelineToast])

  const refreshAfterMutation = useCallback(async () => {
    await Promise.all([
      loadEngagements(),
      loadTimeline(selectedDate),
      loadSettings(),
      loadWeeklySummary(selectedDate),
    ])
  }, [loadEngagements, loadSettings, loadTimeline, loadWeeklySummary, selectedDate])

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

  const setTimelineDragStateWithRef = useCallback(
    (updater: (previous: TimelineDragState | null) => TimelineDragState | null) => {
      setTimelineDragState((previous) => {
        const next = updater(previous)
        timelineDragStateRef.current = next
        return next
      })
    },
    [],
  )

  const commitTimelineDragDrop = useCallback(
    (dragState: TimelineDragState) => {
      const draggedEntry = timelineEntriesRef.current.find((entry) => entry.id === dragState.entryId) ?? null
      if (!draggedEntry) {
        return
      }

      const hasMoved =
        dragState.previewStartMinute !== dragState.originalStartMinute
        || dragState.previewEndMinute !== dragState.originalEndMinute
      if (!hasMoved) {
        return
      }

      const monthKey = monthKeyFromDate(draggedEntry.date)
      const nextStartMinute = dragState.previewStartMinute
      const nextEndMinute = dragState.previewEndMinute

      void runAction(async () => {
        await timelineUpdateEntry({
          id: draggedEntry.id,
          engagementId: draggedEntry.engagementId,
          activityId: draggedEntry.activityId,
          mode: 'drag',
          date: draggedEntry.date,
          startMinute: nextStartMinute,
          endMinute: nextEndMinute,
          description: draggedEntry.description,
        })

        setTimelineLanePreferences((previous) => {
          const nextByEntryId = new Map(previous.byEntryId)
          nextByEntryId.set(draggedEntry.id, dragState.lockedLaneIndex)
          const nextOrder = [
            ...previous.order.filter((entryId) => entryId !== draggedEntry.id),
            draggedEntry.id,
          ]
          return {
            byEntryId: nextByEntryId,
            order: nextOrder,
          }
        })

        await loadTimeline(selectedDateRef.current)
        await loadWeeklySummary(selectedDateRef.current)
        invalidateMonthSummaries([monthKey])
        const nextDraftEndState = buildEntryDraftEndState(nextEndMinute)
        setEntryDraft((previous) =>
          previous && previous.id === draggedEntry.id
            ? {
                ...previous,
                startTime: minuteToTimeInput(nextStartMinute),
                endTime: nextDraftEndState.endTime,
                preserveEndOfDay: nextDraftEndState.preserveEndOfDay,
              }
            : previous,
        )
        setSuccessMessage('Timeline entry moved.')
      })
    },
    [
      invalidateMonthSummaries,
      loadTimeline,
      loadWeeklySummary,
      runAction,
      setTimelineLanePreferences,
    ],
  )

  const trimSubmissionQueue = useCallback((items: SubmissionQueueItem[]) => {
    const activeItems = items.filter((item) => item.state === 'pending' || item.state === 'running')
    const recentFinishedItems = items
      .filter((item) => item.state === 'success' || item.state === 'error')
      .sort(
        (left, right) =>
          (right.completedAtMs ?? right.submittedAtMs) - (left.completedAtMs ?? left.submittedAtMs),
      )
      .slice(0, MAX_FINISHED_QUEUE_HISTORY)

    return [...activeItems, ...recentFinishedItems]
  }, [])

  const processSubmissionQueueItem = useCallback(
    async (item: SubmissionQueueItem) => {
      try {
        const result = await interpretTextMessage({
          rawText: item.rawText,
          openAiModel: item.requestedOpenAiModel,
          clientTimestampIso: item.clientTimestampIso,
          clientLocalDate: item.clientLocalDate,
          clientLocalTime: item.clientLocalTime,
          clientUtcOffsetMinutes: item.clientUtcOffsetMinutes,
          timezone: item.timezone,
        })

        const completedAt = Date.now()
        const completedDurationMs = completedAt - item.submittedAtMs
        setSubmissionQueue((previous) =>
          trimSubmissionQueue(
            previous.map((candidate) =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    state: 'success',
                    statusMessage: formatSubmissionQueueSuccessMessage(
                      result.createdEntryIds.length,
                      new Date(completedAt),
                    ),
                    correlationId: result.correlationId,
                    createdEntryCount: result.createdEntryIds.length,
                    completedAtMs: completedAt,
                    completedDurationMs,
                    modelUsed: result.modelUsed,
                    modelUsedLabel: result.modelUsedLabel,
                  }
                : candidate,
            ),
          ),
        )

        const refreshDate = selectedDateRef.current
        invalidateMonthSummaries(
          result.touchedMonthKeys.length > 0
            ? result.touchedMonthKeys
            : [monthKeyFromDate(refreshDate)],
        )

        await Promise.allSettled([
          loadTimeline(refreshDate),
          loadWeeklySummary(refreshDate),
        ])
      } catch (error) {
        const completedAt = Date.now()
        const correlationId = isAppCommandError(error) ? error.correlationId : undefined
        setSubmissionQueue((previous) =>
          trimSubmissionQueue(
            previous.map((candidate) =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    state: 'error',
                    statusMessage: extractErrorMessage(error),
                    correlationId,
                    completedAtMs: completedAt,
                  }
                : candidate,
            ),
          ),
        )
      } finally {
        inFlightSubmissionIdsRef.current.delete(item.id)
      }
    },
    [
      invalidateMonthSummaries,
      loadTimeline,
      loadWeeklySummary,
      trimSubmissionQueue,
    ],
  )

  useEffect(() => {
    selectedDateRef.current = selectedDate
  }, [selectedDate])

  useEffect(() => {
    timelineEntriesRef.current = timelineEntries
  }, [timelineEntries])

  useEffect(() => {
    const presentEntryIds = new Set(timelineEntries.map((entry) => entry.id))
    setTimelineLanePreferences((previous) => {
      let changed = false
      const nextByEntryId = new Map<string, number>()
      for (const [entryId, laneIndex] of previous.byEntryId.entries()) {
        if (presentEntryIds.has(entryId)) {
          nextByEntryId.set(entryId, laneIndex)
        } else {
          changed = true
        }
      }

      const nextOrder = previous.order.filter((entryId) => presentEntryIds.has(entryId))
      if (nextOrder.length !== previous.order.length) {
        changed = true
      }

      if (!changed) {
        return previous
      }

      return {
        byEntryId: nextByEntryId,
        order: nextOrder,
      }
    })
  }, [timelineEntries])

  const activeTimelineDragPointerId = timelineDragState?.pointerId ?? null

  useEffect(() => {
    if (activeTimelineDragPointerId === null) {
      return
    }

    const finishDrag = (pointerId: number, shouldCommit: boolean) => {
      const current = timelineDragStateRef.current
      if (!current || current.pointerId !== pointerId) {
        return
      }

      if (current.isDragging) {
        suppressTimelineClickRef.current = true
      }
      setTimelineDragStateWithRef(() => null)

      if (shouldCommit && current.isDragging) {
        commitTimelineDragDrop(current)
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      const current = timelineDragStateRef.current
      if (!current || event.pointerId !== current.pointerId) {
        return
      }

      const grid = timelineGridRef.current
      if (!grid) {
        return
      }

      if (
        !current.isDragging
        && Math.abs(event.clientY - current.initialClientY) < TIMELINE_DRAG_ACTIVATION_PX
      ) {
        return
      }

      const pointerMinute = clientYToTimelineMinute(event.clientY, grid, timelineWindow)
      const rawStartMinute = pointerMinute - current.pointerOffsetMinutes
      const snappedStartMinute = snapMinute(rawStartMinute, TIMELINE_DRAG_SNAP_MINUTES)
      const clampedStartMinute = clampStartMinuteForDuration(
        snappedStartMinute,
        current.durationMinutes,
        timelineWindow,
      )
      const nextEndMinute = clampedStartMinute + current.durationMinutes

      setTimelineDragStateWithRef((previous) => {
        if (!previous || previous.pointerId !== event.pointerId) {
          return previous
        }

        if (
          previous.isDragging
          && previous.previewStartMinute === clampedStartMinute
          && previous.previewEndMinute === nextEndMinute
        ) {
          return previous
        }

        return {
          ...previous,
          isDragging: true,
          previewStartMinute: clampedStartMinute,
          previewEndMinute: nextEndMinute,
        }
      })
    }

    const handlePointerUp = (event: PointerEvent) => {
      finishDrag(event.pointerId, true)
    }

    const handlePointerCancel = (event: PointerEvent) => {
      finishDrag(event.pointerId, false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }

      const current = timelineDragStateRef.current
      if (!current) {
        return
      }

      event.preventDefault()
      finishDrag(current.pointerId, false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [
    activeTimelineDragPointerId,
    commitTimelineDragDrop,
    setTimelineDragStateWithRef,
    timelineWindow,
  ])

  useEffect(() => {
    const availableSlots = MAX_CONCURRENT_SUBMISSIONS - inFlightSubmissionIdsRef.current.size
    if (availableSlots <= 0) {
      return
    }

    const pendingItems = submissionQueue
      .filter(
        (item) =>
          item.state === 'pending' && !inFlightSubmissionIdsRef.current.has(item.id),
      )
      .slice(0, availableSlots)

    if (pendingItems.length === 0) {
      return
    }

    const pendingIds = new Set(pendingItems.map((item) => item.id))
    setSubmissionQueue((previous) =>
      previous.map((item) =>
        pendingIds.has(item.id)
          ? {
              ...item,
              state: 'running',
              statusMessage: 'Your message is sent and is being processed.',
            }
          : item,
      ),
    )

    for (const pendingItem of pendingItems) {
      inFlightSubmissionIdsRef.current.add(pendingItem.id)
      void processSubmissionQueueItem(pendingItem)
    }
  }, [processSubmissionQueueItem, submissionQueue])

  const onSubmitCapture = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const messageToSend = captureMessage.trim()
    if (messageToSend.length === 0) {
      return
    }

    const submittedAt = new Date()
    const queueItem: SubmissionQueueItem = {
      id: generateSubmissionQueueId(),
      rawText: messageToSend,
      submittedAtMs: submittedAt.getTime(),
      requestedOpenAiModel: settingsStatus?.selectedOpenAiModel ?? DEFAULT_OPENAI_MODEL,
      clientTimestampIso: submittedAt.toISOString(),
      clientLocalDate: formatDate(submittedAt),
      clientLocalTime: formatLocalTime(submittedAt),
      clientUtcOffsetMinutes: -submittedAt.getTimezoneOffset(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      state: 'pending',
      statusMessage: 'Queued for processing.',
    }

    setCaptureMessage('')
    setSubmissionQueue((previous) => [...previous, queueItem])
    setIsSubmissionQueueOpen(true)
  }

  const onSubmitEngagement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const isEditing = codeEditorSurface === 'edit-engagement'

    void runAction(async () => {
      const describeWhenToUse = engagementForm.describeWhenToUse.trim()
      if (describeWhenToUse.length === 0) {
        throw new Error('"Describe when to use" is required for matching.')
      }

      const colorHex = normalizeColorHexInput(engagementForm.colorHex)
      if (engagementForm.colorHex.trim().length > 0 && !colorHex) {
        throw new Error('Engagement color must be a valid #RRGGBB value.')
      }

      await engagementUpsert({
        id: engagementForm.id,
        code: engagementForm.code.trim() || null,
        name: engagementForm.name,
        client: engagementForm.client || null,
        colorHex,
        describeWhenToUse,
        tags: parseTagInput(engagementForm.tags),
        isActive: engagementForm.isActive,
      })

      setEngagementForm(EMPTY_ENGAGEMENT_FORM)
      await refreshAfterMutation()
      if (isEditing) {
        setCodeEditorSurface(null)
      } else {
        setCodeEditorSurface('create-engagement')
        setEditorActivationKey((previous) => previous + 1)
      }
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
    setExpandedEngagementId(engagement.id)
    setCodeEditorSurface('edit-engagement')
    setEngagementForm({
      id: engagement.id,
      code: engagement.code ?? '',
      name: engagement.name,
      client: engagement.client ?? '',
      colorHex: engagement.colorHex ?? '',
      describeWhenToUse: engagement.describeWhenToUse ?? '',
      tags: joinTags(engagement.tags),
      isActive: engagement.isActive,
    })
    setEditorActivationKey((previous) => previous + 1)
  }

  const onSubmitActivity = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const isEditing = codeEditorSurface === 'edit-activity'
    const nextEngagementId =
      activityForm.engagementId || getDefaultActivityEngagementId(engagements)

    void runAction(async () => {
      const describeWhenToUse = activityForm.describeWhenToUse.trim()
      if (describeWhenToUse.length === 0) {
        throw new Error('"Describe when to use" is required for matching.')
      }

      const colorHex = normalizeColorHexInput(activityForm.colorHex)
      if (activityForm.colorHex.trim().length > 0 && !colorHex) {
        throw new Error('Activity color must be a valid #RRGGBB value.')
      }

      await activityUpsert({
        id: activityForm.id,
        engagementId: activityForm.engagementId,
        code: activityForm.code.trim() || null,
        name: activityForm.name,
        colorHex,
        describeWhenToUse,
        tags: parseTagInput(activityForm.tags),
        isActive: activityForm.isActive,
      })

      setActivityForm(buildEmptyActivityForm(nextEngagementId))
      await refreshAfterMutation()
      if (isEditing) {
        setCodeEditorSurface(null)
      } else {
        setCodeEditorSurface('create-activity')
        setEditorActivationKey((previous) => previous + 1)
      }
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
    setExpandedEngagementId(activity.engagementId)
    setCodeEditorSurface('edit-activity')
    setActivityForm({
      id: activity.id,
      engagementId: activity.engagementId,
      code: activity.code ?? '',
      name: activity.name,
      colorHex: activity.colorHex ?? '',
      describeWhenToUse: activity.describeWhenToUse ?? '',
      tags: joinTags(activity.tags),
      isActive: activity.isActive,
    })
    setEditorActivationKey((previous) => previous + 1)
  }

  const onSetDate = (nextDate: string) => {
    if (nextDate === selectedDate) {
      return
    }

    pendingAutoCenterDateRef.current = nextDate
    setSelectedDate(nextDate)
    setVisibleMonth(monthKeyFromDate(nextDate))
    setSelectedEntryId(null)
    setEntryDraft(null)
    setTimelineContextMenu(null)
    setTimelineDragStateWithRef(() => null)
  }

  const onJumpToToday = () => {
    onSetDate(formatDate(new Date()))
  }

  const onSelectCalendarDate = (nextDate: string) => {
    onSetDate(nextDate)
  }

  const onSelectEntry = (entry: TimelineEntry) => {
    setTimelineContextMenu(null)
    setSelectedEntryId(entry.id)
    setEntryDraft(buildEntryDraft(entry))
  }

  const onSelectTimelineBlock = (entry: TimelineEntry) => {
    if (suppressTimelineClickRef.current) {
      suppressTimelineClickRef.current = false
      return
    }

    onSelectEntry(entry)
  }

  const onStartTimelineDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    entry: TimelineEntry,
  ) => {
    if (event.button !== 0 || isBusy || isTimelineLoading || isTimelineDeleteBusy) {
      return
    }

    const grid = timelineGridRef.current
    if (!grid) {
      return
    }

    const durationMinutes = Math.max(
      entry.endMinute - entry.startMinute,
      TIMELINE_DRAG_SNAP_MINUTES,
    )
    const pointerMinute = clientYToTimelineMinute(event.clientY, grid, timelineWindow)
    const pointerOffsetMinutes = Math.min(
      durationMinutes,
      Math.max(0, pointerMinute - entry.startMinute),
    )

    event.preventDefault()
    suppressTimelineClickRef.current = false
    onSelectEntry(entry)
    const lockedLaneIndex = baselinePositionedTimelineEntries.find(
      (positionedEntry) => positionedEntry.entry.id === entry.id,
    )?.laneIndex ?? 0

    setTimelineDragStateWithRef(() => ({
      entryId: entry.id,
      pointerId: event.pointerId,
      initialClientY: event.clientY,
      lockedLaneIndex,
      pointerOffsetMinutes,
      durationMinutes,
      originalStartMinute: entry.startMinute,
      originalEndMinute: entry.endMinute,
      previewStartMinute: entry.startMinute,
      previewEndMinute: entry.endMinute,
      isDragging: false,
    }))
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

    if (entryDraft.startTime.trim().length === 0) {
      setSuccessMessage(null)
      setErrorMessage('Start time is required.')
      return
    }

    if (entryDraft.endTime.trim().length === 0) {
      setSuccessMessage(null)
      setErrorMessage('End time is required.')
      return
    }

    const startMinute = timeInputToMinute(entryDraft.startTime)
    const endMinute = resolveEntryDraftEndMinute(entryDraft)
    if (endMinute <= startMinute) {
      setSuccessMessage(null)
      setErrorMessage('End time must be later than start time.')
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
        mode: 'manual',
        date: entryDraft.date,
        startMinute,
        endMinute,
        description: entryDraft.description,
      })

      await loadTimeline(selectedDate)
      await loadWeeklySummary(selectedDate)
      invalidateMonthSummaries([previousMonthKey, nextMonthKey])
      const nextDraftEndState = buildEntryDraftEndState(endMinute)
      setEntryDraft((previous) =>
        previous && previous.id === entryDraft.id
          ? {
              ...previous,
              startTime: minuteToTimeInput(startMinute),
              endTime: nextDraftEndState.endTime,
              preserveEndOfDay: nextDraftEndState.preserveEndOfDay,
            }
          : previous,
      )
      setSuccessMessage('Timeline entry updated.')
    })
  }

  const onDeleteTimelineEntry = (id: string) => {
    if (isTimelineDeleteBusy) {
      return
    }

    void (async () => {
      const existingEntry = timelineEntries.find((entry) => entry.id === id) ?? null
      const entryDate = existingEntry?.date ?? selectedDate
      const monthKey = monthKeyFromDate(entryDate)
      const previousScrollTop = timelineGridRef.current?.scrollTop ?? 0

      try {
        setIsTimelineDeleteBusy(true)
        setTimelineContextMenu(null)
        await timelineDeleteEntry(id)
        await loadTimeline(selectedDate)
        await loadWeeklySummary(selectedDate)

        window.requestAnimationFrame(() => {
          const grid = timelineGridRef.current
          if (!grid) {
            return
          }

          const maxScrollTop = Math.max(0, grid.scrollHeight - grid.clientHeight)
          grid.scrollTop = Math.min(previousScrollTop, maxScrollTop)
        })

        invalidateMonthSummaries([monthKey])
        timelineToastIdRef.current += 1
        setTimelineToast({
          id: timelineToastIdRef.current,
          kind: 'success',
          message: 'Timeline entry deleted.',
        })
      } catch (error) {
        timelineToastIdRef.current += 1
        setTimelineToast({
          id: timelineToastIdRef.current,
          kind: 'error',
          message: extractErrorMessage(error),
        })
      } finally {
        setIsTimelineDeleteBusy(false)
      }
    })()
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
          'OpenAI API key saved for this app session only because OS keyring is unavailable.',
        )
      } else {
        setSuccessMessage('OpenAI API key saved securely.')
      }
    })
  }

  const onSaveOpenAiModel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void runAction(async () => {
      await settingsSetOpenAiModel(selectedOpenAiModelDraft)
      const status = await settingsGetStatus()
      setSettingsStatus(status)
      setSelectedOpenAiModelDraft(status.selectedOpenAiModel)
      setSuccessMessage('OpenAI model preference saved.')
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

  const onShiftSummaryWeek = (weekDelta: number) => {
    onSetDate(shiftDate(selectedDate, weekDelta * 7))
  }

  const onExportSummaryWeek = () => {
    if (!weeklySummary) {
      setErrorMessage('No summary data available to export.')
      return
    }

    void runAction(async () => {
      setIsSummaryExporting(true)
      try {
        const result = await summaryExportWeeklyExcel({ date: selectedDate })
        if (!result.autoOpenAttempted || result.autoOpenSucceeded) {
          setSuccessMessage(`Weekly summary exported and opened: ${result.filePath}`)
          return
        }

        setSuccessMessage(
          `Weekly summary exported to ${result.filePath}. Auto-open failed: ${result.autoOpenError ?? 'unknown error'}`,
        )
      } finally {
        setIsSummaryExporting(false)
      }
    })
  }

  const onOpenSummaryNotes = (rowIndex: number, dayIndex: number) => {
    setSummaryNotesModal({
      rowIndex,
      dayIndex,
    })
  }

  const onCloseSummaryNotes = () => {
    setSummaryNotesModal(null)
  }

  const onCopySummaryNotes = () => {
    if (!selectedSummaryNotesContext) {
      return
    }

    const text = formatSummaryNotesForClipboard(selectedSummaryNotesContext.notes)
    void runAction(async () => {
      try {
        await navigator.clipboard.writeText(text)
        setSuccessMessage('Summary notes copied to clipboard.')
      } catch {
        setErrorMessage('Clipboard is not available in this environment.')
      }
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
          <section className="sidebar-section sidebar-capture">
            <div className="sidebar-section-header">
              <h2>Submit an entry</h2>
              <p>Submit what you worked on.</p>
            </div>
            <form onSubmit={onSubmitCapture} className="stack">
              <textarea
                value={captureMessage}
                onChange={(event) => setCaptureMessage(event.target.value)}
                placeholder="Example: Just finished a 30 minute SAP ITGC meeting with the Orange team"
                rows={4}
                required
              />
              <button type="submit" disabled={captureMessage.trim().length === 0}>
                Send
              </button>
            </form>

            <div className="submission-queue">
              <button
                type="button"
                className="submission-queue-toggle"
                aria-expanded={isSubmissionQueueOpen}
                onClick={() => setIsSubmissionQueueOpen((previous) => !previous)}
              >
                <span>Submission Queue</span>
                <span
                  className={`submission-queue-toggle-icon ${isSubmissionQueueOpen ? 'open' : ''}`}
                  aria-hidden="true"
                >
                  ▾
                </span>
              </button>

              {isSubmissionQueueOpen ? (
                <div className="submission-queue-list" role="list" aria-label="Submission queue items">
                  {submissionQueueDisplayItems.length === 0 ? (
                    <p className="submission-queue-empty">Submission queue is empty</p>
                  ) : (
                    submissionQueueDisplayItems.map((item) => (
                      <div key={item.id} className={`submission-queue-item ${item.state}`} role="listitem">
                        <div className="submission-queue-item-header">
                          <p className="submission-queue-item-text">{item.rawText}</p>
                          <span className={`submission-queue-item-badge ${item.state}`}>
                            {formatSubmissionQueueStateLabel(item.state)}
                          </span>
                        </div>
                        <p className="submission-queue-item-meta">
                          Submitted {formatSubmissionQueueTimestamp(item.submittedAtMs)}
                        </p>
                        <p className="submission-queue-item-status">{item.statusMessage}</p>
                        {item.state === 'success' && item.createdEntryCount !== undefined ? (
                          <p className="submission-queue-item-meta">
                            Entries created: {item.createdEntryCount}
                          </p>
                        ) : null}
                        {item.correlationId ? (
                          <p className="submission-queue-item-meta">
                            Correlation ID: <code>{item.correlationId}</code>
                          </p>
                        ) : null}
                        {item.state === 'success' && item.completedDurationMs !== undefined ? (
                          <p className="submission-queue-item-meta">
                            Completed in: {formatSubmissionQueueDuration(item.completedDurationMs)}
                          </p>
                        ) : null}
                        {item.state === 'success' && item.modelUsedLabel ? (
                          <p className="submission-queue-item-meta">
                            Model used: {item.modelUsedLabel}
                          </p>
                        ) : null}
                      </div>
                    ))
                  )}
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
              highlightedDates={summaryWeekHighlightedDates}
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
                key={view.id}
                type="button"
                role="tab"
                aria-selected={activeView === view.id}
                className={activeView === view.id ? 'active' : ''}
                onClick={() => setActiveView(view.id)}
              >
                {view.label}
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
                <h2 className="timeline-date-heading">
                  <strong>{timelineHeaderDate.monthDay}</strong>, {timelineHeaderDate.year}
                </h2>
                <p className="timeline-range">
                  {timelineHeaderDate.weekday}
                </p>
              </div>
              <div className="timeline-controls">
                <button
                  type="button"
                  className="timeline-arrow-button"
                  aria-label="Previous day"
                  onClick={() => onSetDate(shiftDate(selectedDate, -1))}
                  disabled={isBusy || isTimelineLoading}
                >
                  {'<'}
                </button>
                <button
                  type="button"
                  onClick={onJumpToToday}
                  disabled={isBusy || isTimelineLoading}
                >
                  Today
                </button>
                <button
                  type="button"
                  className="timeline-arrow-button"
                  aria-label="Next day"
                  onClick={() => onSetDate(shiftDate(selectedDate, 1))}
                  disabled={isBusy || isTimelineLoading}
                >
                  {'>'}
                </button>
              </div>
            </div>

            <div className="timeline-layout">
              <div
                className={`timeline-grid ${timelineDragState?.isDragging ? 'dragging' : ''}`}
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
                    {draggedEntryOriginPosition
                      ? (() => {
                        const ghostEntry = draggedEntryOriginPosition.entry
                        const ghostColor = resolveTimelineBlockColor(
                          ghostEntry,
                          activityColorById,
                          engagementColorById,
                        )
                        const ghostLabel = buildTimelineBlockLabel(
                          ghostEntry,
                          draggedEntryOriginPosition.widthPercent,
                          draggedEntryOriginPosition.height,
                        )
                        const ghostReviewLabel = getTimelineBlockReviewLabel(ghostEntry.warningFlags)
                        const ghostAccentColor = deriveTimelineAccentColor(ghostColor)
                        const ghostNeedsReview = ghostReviewLabel !== null

                        return (
                          <div
                            className={`timeline-block drag-origin-ghost tier-${ghostLabel.tier} ${ghostNeedsReview ? 'needs-review' : ''}`}
                            style={{
                              top: draggedEntryOriginPosition.top,
                              height: draggedEntryOriginPosition.height,
                              left: `${draggedEntryOriginPosition.leftPercent}%`,
                              width: `${draggedEntryOriginPosition.widthPercent}%`,
                              '--timeline-block-color': ghostColor,
                              '--timeline-block-accent': ghostAccentColor,
                              backgroundColor: ghostColor,
                              color: colorForBackground(ghostColor),
                            } as CSSProperties}
                            aria-hidden="true"
                          >
                            <TimelineBlockContent label={ghostLabel.label} />
                          </div>
                        )
                      })()
                      : null}
                    {previewPositionedTimelineEntries.map((positionedEntry) => {
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
                      const reviewLabel = getTimelineBlockReviewLabel(entry.warningFlags)
                      const needsReview = reviewLabel !== null
                      const isDragPreview =
                        timelineDragState?.isDragging
                        && timelineDragState.entryId === entry.id
                      const textColor = colorForBackground(blockColor)
                      const blockAccentColor = deriveTimelineAccentColor(blockColor)

                      if (isDragPreview) {
                        return (
                          <div
                            key={entry.id}
                            className={`timeline-block drag-preview tier-${blockLabel.tier}`}
                            style={{
                              top: positionedEntry.top,
                              height: positionedEntry.height,
                              left: `${positionedEntry.leftPercent}%`,
                              width: `${positionedEntry.widthPercent}%`,
                              '--timeline-block-color': blockColor,
                              '--timeline-block-accent': blockAccentColor,
                              borderColor: blockColor,
                            } as CSSProperties}
                            aria-hidden="true"
                          >
                            <TimelineBlockContent label={blockLabel.label} />
                          </div>
                        )
                      }

                      const blockClassName = [
                        'timeline-block',
                        `tier-${blockLabel.tier}`,
                        selectedEntryId === entry.id ? 'selected' : '',
                        needsReview ? 'needs-review' : '',
                      ]
                        .filter((className) => className.length > 0)
                        .join(' ')

                      return (
                        <button
                          type="button"
                          key={entry.id}
                          className={blockClassName}
                          style={{
                            top: positionedEntry.top,
                            height: positionedEntry.height,
                            left: `${positionedEntry.leftPercent}%`,
                            width: `${positionedEntry.widthPercent}%`,
                            '--timeline-block-color': blockColor,
                            '--timeline-block-accent': blockAccentColor,
                            backgroundColor: blockColor,
                            color: textColor,
                          } as CSSProperties}
                          onClick={() => onSelectTimelineBlock(entry)}
                          onPointerDown={(event) => onStartTimelineDrag(event, entry)}
                          onContextMenu={(event) => {
                            if (timelineDragState?.isDragging) {
                              event.preventDefault()
                              return
                            }
                            onOpenTimelineContextMenu(event, entry)
                          }}
                          title={buildTimelineBlockTitle(
                            blockLabel.fullLabel,
                            entry.description,
                            reviewLabel,
                          )}
                          aria-label={buildTimelineBlockAriaLabel(
                            blockLabel.fullLabel,
                            entry.description,
                            reviewLabel,
                          )}
                          aria-haspopup="menu"
                        >
                          <TimelineBlockContent label={blockLabel.label} />
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
                            {formatEntityDisplayLabel(engagement.name, engagement.code)}
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
                            {formatEntityDisplayLabel(activity.name, activity.code)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Start
                      <input
                        type="time"
                        step={60}
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
                        step={60}
                        value={entryDraft.endTime}
                        onChange={(event) =>
                          setEntryDraft((previous) =>
                            previous
                              ? {
                                  ...previous,
                                  endTime: event.target.value,
                                  preserveEndOfDay: false,
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
                    <div className="timeline-entry-actions">
                      <button type="submit" disabled={isBusy}>
                        Save Entry
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => onDeleteTimelineEntry(entryDraft.id)}
                        disabled={isBusy || isTimelineDeleteBusy}
                      >
                        Delete Entry
                      </button>
                    </div>
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
                    {selectedEntry.modelUsedLabel ? (
                      <p>Model Used: {selectedEntry.modelUsedLabel}</p>
                    ) : null}
                    {selectedEntry.durationDefaulted ? (
                      <p>
                        Duration: Defaulted to {selectedEntry.durationMinutes} minutes (not specified in
                        message).
                      </p>
                    ) : null}
                    {selectedEntry.fallbackSummary ? (
                      <p>Fallback: {selectedEntry.fallbackSummary}</p>
                    ) : null}
                    {selectedEntryHasMultiEventSource ? (
                      <p>
                        Capture provenance: Event {selectedEntry.sourceMessageEntryIndex ?? '?'} of{' '}
                        {selectedEntry.sourceMessageEntryCount} from one message.
                      </p>
                    ) : null}
                    {selectedEntryHasMultiEventSource || selectedEntry.warningFlags.length > 0 ? (
                      <div className="warning-row">
                        {selectedEntryHasMultiEventSource ? (
                          <span className="warning-badge provenance">Multi-Event Source</span>
                        ) : null}
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
              <div className="code-panel-header">
                <h2>Engagements and Activities</h2>
                <p>These are the projects/engagements that OmniSheet will match to your submitted activity.</p>
              </div>

              <div ref={codeFormsBodyRef} className="code-forms-body">
                <div className="code-editor-accordion">
                  <section className={`code-editor-section ${isEngagementEditorOpen ? 'expanded' : ''}`}>
                    <button
                      type="button"
                      className="code-editor-trigger"
                      aria-expanded={isEngagementEditorOpen}
                      aria-controls="engagement-editor-panel"
                      onClick={toggleEngagementEditor}
                    >
                      <span className="code-editor-trigger-title">
                        {isEditingEngagement ? 'Edit Engagement' : 'Create Engagement'}
                      </span>
                      <span
                        className={`code-editor-trigger-icon ${isEngagementEditorOpen ? 'open' : ''}`}
                        aria-hidden="true"
                      />
                    </button>

                    {isEngagementEditorOpen ? (
                      <div id="engagement-editor-panel" className="code-editor-panel">
                        <form className="stack code-editor-form" onSubmit={onSubmitEngagement}>
                          <label>
                            <span className="field-label-row">
                              Name
                              <span className="required-indicator" aria-hidden="true">*</span>
                            </span>
                            <span className="field-helper">Required for matching</span>
                            <input
                              ref={engagementNameInputRef}
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
                            Code
                            <input
                              value={engagementForm.code}
                              onChange={(event) =>
                                setEngagementForm((previous) => ({
                                  ...previous,
                                  code: event.target.value,
                                }))
                              }
                            />
                          </label>
                          <label>
                            <span className="field-label-row">
                              Describe when to use this engagement
                              <span className="required-indicator" aria-hidden="true">*</span>
                            </span>
                            <span className="field-helper">Required for matching</span>
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
                              required
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
                            Color
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
                          </label>
                          <div className="code-editor-actions">
                            <button type="submit" disabled={isBusy}>
                              {isEditingEngagement ? 'Update Engagement' : 'Create Engagement'}
                            </button>
                            <button type="button" className="ghost" onClick={closeCodeEditor}>
                              Cancel
                            </button>
                          </div>
                        </form>
                      </div>
                    ) : null}
                  </section>

                  <section className={`code-editor-section ${isActivityEditorOpen ? 'expanded' : ''}`}>
                    <button
                      type="button"
                      className="code-editor-trigger"
                      aria-expanded={isActivityEditorOpen}
                      aria-controls="activity-editor-panel"
                      onClick={toggleActivityEditor}
                      disabled={!canCreateActivity}
                    >
                      <span className="code-editor-trigger-title">
                        {isEditingActivity ? 'Edit Activity' : 'Create Activity'}
                      </span>
                      <span
                        className={`code-editor-trigger-icon ${isActivityEditorOpen ? 'open' : ''}`}
                        aria-hidden="true"
                      />
                    </button>

                    {isActivityEditorOpen ? (
                      <div id="activity-editor-panel" className="code-editor-panel">
                        {isEditingActivity && selectedActivityEngagement ? (
                          <p className="code-editor-context">
                            Editing activity in <strong>{selectedActivityEngagement.code}</strong>
                            {' '}{selectedActivityEngagement.name}
                          </p>
                        ) : null}
                        <form className="stack code-editor-form" onSubmit={onSubmitActivity}>
                          <label>
                            Engagement
                            <select
                              ref={activityEngagementSelectRef}
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
                                  {formatEntityDisplayLabel(engagement.name, engagement.code)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span className="field-label-row">
                              Name
                              <span className="required-indicator" aria-hidden="true">*</span>
                            </span>
                            <span className="field-helper">Required for matching</span>
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
                            Code
                            <input
                              value={activityForm.code}
                              onChange={(event) =>
                                setActivityForm((previous) => ({
                                  ...previous,
                                  code: event.target.value,
                                }))
                              }
                            />
                          </label>
                          <label>
                            <span className="field-label-row">
                              Describe when to use this activity
                              <span className="required-indicator" aria-hidden="true">*</span>
                            </span>
                            <span className="field-helper">Required for matching</span>
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
                              placeholder="Use this activity when..."
                              required
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
                          <label>
                            Color
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
                                value={activityForm.colorHex || selectedEngagementColorValue || ''}
                                onChange={(event) =>
                                  setActivityForm((previous) => ({
                                    ...previous,
                                    colorHex: event.target.value.toUpperCase(),
                                  }))
                                }
                                placeholder="#RRGGBB"
                                maxLength={7}
                              />
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
                          </label>
                          <div className="code-editor-actions">
                            <button type="submit" disabled={isBusy || engagements.length === 0}>
                              {isEditingActivity ? 'Update Activity' : 'Create Activity'}
                            </button>
                            <button type="button" className="ghost" onClick={closeCodeEditor}>
                              Cancel
                            </button>
                          </div>
                        </form>
                      </div>
                    ) : null}

                    {!canCreateActivity ? (
                      <p className="code-editor-choice-hint">Create an engagement first.</p>
                    ) : null}
                  </section>
                </div>
              </div>
            </div>

            <div className="code-browse-panel">
              <div className="code-panel-header">
                <h2>Existing Engagements & Activities</h2>
                <p>Click to expand and review/edit the related activities.</p>
              </div>

              <div className="code-list" aria-label="Existing engagements and activities">
                {engagements.length === 0 ? (
                  <p className="code-list-empty">No engagements yet. Create one to get started.</p>
                ) : (
                  engagements.map((engagement) => {
                    const engagementColor =
                      normalizeColorHexInput(engagement.colorHex) ?? TIMELINE_NEUTRAL_COLOR
                    const engagementUsage =
                      engagement.describeWhenToUse?.trim() || 'Usage guidance not added yet.'
                    const isExpanded = engagement.id === expandedEngagementId
                    const engagementPanelId = `engagement-panel-${engagement.id}`

                    return (
                      <article
                        key={engagement.id}
                        className={`engagement-card ${isExpanded ? 'expanded' : ''}`}
                        style={{ borderLeftColor: engagementColor }}
                      >
                        <div className="engagement-card-header">
                          <div className="engagement-card-main">
                            <h3 className="engagement-card-heading">
                              <button
                                type="button"
                                className="engagement-disclosure"
                                aria-expanded={isExpanded}
                                aria-controls={engagementPanelId}
                                onClick={() =>
                                  setExpandedEngagementId((previous) =>
                                    previous === engagement.id ? null : engagement.id,
                                  )
                                }
                              >
                                <span className="engagement-disclosure-main">
                                  <span className="engagement-disclosure-icon" aria-hidden="true" />
                                    <span className="code-item-copy">
                                      <span className="code-item-title">
                                      {engagement.code ? (
                                        <span className="code-item-badge">{engagement.code}</span>
                                      ) : null}
                                      <span className="code-item-name">{engagement.name}</span>
                                    </span>
                                    <span
                                      className={`code-item-usage ${engagement.describeWhenToUse?.trim() ? '' : 'is-placeholder'}`}
                                    >
                                      {engagementUsage}
                                    </span>
                                    <ResponsiveCodeTagList tags={engagement.tags} itemKeyPrefix={engagement.id} />
                                  </span>
                                </span>
                                <span className="activity-count-pill">
                                  {formatActivityCount(engagement.activities.length)}
                                </span>
                              </button>
                            </h3>
                          </div>

                          <div className="code-item-actions">
                            <button
                              type="button"
                              className="icon-action-button"
                              aria-label={`Edit engagement ${formatEntityDisplayLabel(engagement.name, engagement.code)}`}
                              title={`Edit engagement ${formatEntityDisplayLabel(engagement.name, engagement.code)}`}
                              onClick={() => onEditEngagement(engagement)}
                            >
                              <img src={editIcon} alt="" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="icon-action-button is-danger"
                              aria-label={`Delete engagement ${formatEntityDisplayLabel(engagement.name, engagement.code)}`}
                              title={`Delete engagement ${formatEntityDisplayLabel(engagement.name, engagement.code)}`}
                              onClick={() => onDeleteEngagement(engagement.id)}
                            >
                              <img src={deleteIcon} alt="" aria-hidden="true" />
                            </button>
                          </div>
                        </div>

                        <div id={engagementPanelId} className="engagement-activities" hidden={!isExpanded}>
                          {engagement.activities.length === 0 ? (
                            <p className="engagement-empty-state">No activities yet.</p>
                          ) : (
                            <ul>
                              {engagement.activities.map((activity) => {
                                const activityColor =
                                  normalizeColorHexInput(activity.colorHex)
                                  ?? normalizeColorHexInput(engagement.colorHex)
                                  ?? TIMELINE_NEUTRAL_COLOR
                                const activityUsage =
                                  activity.describeWhenToUse?.trim() || 'Usage guidance not added yet.'

                                return (
                                  <li
                                    key={activity.id}
                                    className="activity-row"
                                    style={{ borderLeftColor: activityColor }}
                                  >
                                    <div className="code-item-copy">
                                      <div className="code-item-title">
                                        {activity.code ? (
                                          <span className="code-item-badge">{activity.code}</span>
                                        ) : null}
                                        <span className="code-item-name">{activity.name}</span>
                                      </div>
                                      <p
                                        className={`code-item-usage ${activity.describeWhenToUse?.trim() ? '' : 'is-placeholder'}`}
                                      >
                                        {activityUsage}
                                      </p>
                                      <ResponsiveCodeTagList tags={activity.tags} itemKeyPrefix={activity.id} />
                                    </div>

                                    <div className="code-item-actions">
                                      <button
                                        type="button"
                                        className="icon-action-button"
                                        aria-label={`Edit activity ${formatEntityDisplayLabel(activity.name, activity.code)}`}
                                        title={`Edit activity ${formatEntityDisplayLabel(activity.name, activity.code)}`}
                                        onClick={() => onEditActivity(activity)}
                                      >
                                        <img src={editIcon} alt="" aria-hidden="true" />
                                      </button>
                                      <button
                                        type="button"
                                        className="icon-action-button is-danger"
                                        aria-label={`Delete activity ${formatEntityDisplayLabel(activity.name, activity.code)}`}
                                        title={`Delete activity ${formatEntityDisplayLabel(activity.name, activity.code)}`}
                                        onClick={() => onDeleteActivity(activity.id)}
                                      >
                                        <img src={deleteIcon} alt="" aria-hidden="true" />
                                      </button>
                                    </div>
                                  </li>
                                )
                              })}
                            </ul>
                          )}
                        </div>
                      </article>
                    )
                  })
                )}
              </div>
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
            <form className="stack" onSubmit={onSaveOpenAiModel}>
              <label>
                OpenAI Model
                <select
                  value={selectedOpenAiModelDraft}
                  onChange={(event) =>
                    setSelectedOpenAiModelDraft(event.target.value as OpenAiModelId)
                  }
                  disabled={isBusy || settingsStatus === null}
                >
                  {(settingsStatus?.availableOpenAiModels ?? []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                disabled={
                  isBusy ||
                  settingsStatus === null ||
                  selectedOpenAiModelDraft === settingsStatus.selectedOpenAiModel
                }
              >
                Save Model Preference
              </button>
            </form>
            <p>
              Key configured: <strong>{settingsStatus?.hasOpenAiKey ? 'Yes' : 'No'}</strong>
            </p>
            <p>
              Selected model:{' '}
              <strong>
                {settingsStatus
                  ? settingsStatus.availableOpenAiModels.find(
                      (model) => model.id === settingsStatus.selectedOpenAiModel,
                    )?.label ?? 'unknown'
                  : 'unknown'}
              </strong>
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

        {activeView === 'summary' ? (
          <section className="panel summary-panel">
            <div className="summary-toolbar">
              <div className="summary-title-block">
                <h2>Weekly Summary</h2>
                {weeklySummary ? (
                  <p className="summary-week-range">
                    Week: {weeklySummary.weekStartDate} - {weeklySummary.weekEndDate}
                  </p>
                ) : (
                  <p className="summary-week-range">Week: {selectedDate}</p>
                )}
              </div>
              <div className="summary-week-controls">
                <button
                  type="button"
                  onClick={() => onShiftSummaryWeek(-1)}
                  disabled={isBusy || isWeeklySummaryLoading || isSummaryExporting}
                >
                  Previous Week
                </button>
                <button
                  type="button"
                  onClick={() => onShiftSummaryWeek(1)}
                  disabled={isBusy || isWeeklySummaryLoading || isSummaryExporting}
                >
                  Next Week
                </button>
                <button
                  type="button"
                  onClick={onExportSummaryWeek}
                  disabled={isBusy || isWeeklySummaryLoading || isSummaryExporting || !weeklySummary}
                >
                  {isSummaryExporting ? 'Exporting...' : 'Export'}
                </button>
              </div>
            </div>

            <div className="summary-week-total">
              <span>Week Total Hours</span>
              <strong>
                {weeklySummary
                  ? formatMinutesAsHours(weeklySummary.weekTotalMinutes)
                  : '--'}
              </strong>
            </div>

            {weeklySummaryError ? (
              <p className="mini-calendar-error">{weeklySummaryError}</p>
            ) : null}

            <div className="summary-table-wrap" aria-busy={isWeeklySummaryLoading}>
              {isWeeklySummaryLoading ? (
                <p>Loading weekly summary...</p>
              ) : weeklySummary ? (
                <table className="summary-table">
                  <thead>
                    <tr>
                      <th>Engagement Code</th>
                      <th>Activity Code</th>
                      <th>Activity Name</th>
                      <th>Engagement Name</th>
                      <th>Client Name</th>
                      {weeklySummary.days.map((day, dayIndex) => (
                        <th key={day.date}>
                          {SUMMARY_DAY_NAMES[dayIndex]} ({formatMonthDay(day.date)})
                        </th>
                      ))}
                      <th>Row Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weeklySummary.rows.length === 0 ? (
                      <tr>
                        <td colSpan={13} className="summary-empty-row">
                          No time entries for this week.
                        </td>
                      </tr>
                    ) : (
                      weeklySummary.rows.map((row, rowIndex) => (
                        <tr key={`${row.engagementCode}-${row.activityCode}-${rowIndex}`}>
                          <td className={row.isUncategorized ? 'summary-uncategorized' : ''}>
                            {formatSummaryCodeValue(row.engagementCode, row.isUncategorized)}
                          </td>
                          <td className={row.isUncategorized ? 'summary-uncategorized' : ''}>
                            {formatSummaryCodeValue(row.activityCode, row.isUncategorized)}
                          </td>
                          <td>{row.activityName}</td>
                          <td>{row.engagementName}</td>
                          <td>{row.clientName || '-'}</td>
                          {row.cells.map((cell, dayIndex) => (
                            <td key={`${rowIndex}-${dayIndex}`}>
                              {cell.totalMinutes > 0 ? (
                                <div className="summary-cell-value-wrap">
                                  <span>{formatMinutesAsHours(cell.totalMinutes)}</span>
                                  <button
                                    type="button"
                                    className="ghost summary-notes-button"
                                    onClick={() => onOpenSummaryNotes(rowIndex, dayIndex)}
                                  >
                                    Notes
                                  </button>
                                </div>
                              ) : (
                                <span className="summary-zero">-</span>
                              )}
                            </td>
                          ))}
                          <td className="summary-row-total">
                            {formatMinutesAsHours(row.rowTotalMinutes)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="summary-total-row">
                      <th colSpan={5}>Day Totals</th>
                      {weeklySummary.dayTotalMinutes.map((totalMinutes, dayIndex) => (
                        <td key={`total-${dayIndex}`}>
                          {formatMinutesAsHours(totalMinutes)}
                        </td>
                      ))}
                      <td>{formatMinutesAsHours(weeklySummary.weekTotalMinutes)}</td>
                    </tr>
                  </tfoot>
                </table>
              ) : (
                <p>No summary data available.</p>
              )}
            </div>
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
            disabled={isBusy || isTimelineDeleteBusy}
          >
            Delete Entry
          </button>
        </div>,
        document.body,
      ) : null}
      {timelineToast ? createPortal(
        <div className="timeline-toast-stack" role="status" aria-live="polite">
          <div key={timelineToast.id} className={`timeline-toast ${timelineToast.kind}`}>
            <p>{timelineToast.message}</p>
            <button
              type="button"
              className="timeline-toast-close"
              onClick={() => setTimelineToast(null)}
              aria-label="Dismiss notification"
            >
              x
            </button>
          </div>
        </div>,
        document.body,
      ) : null}
      {selectedSummaryNotesContext ? createPortal(
        <div
          className="summary-notes-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              onCloseSummaryNotes()
            }
          }}
        >
          <div
            ref={summaryNotesModalRef}
            className="summary-notes-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Summary notes details"
          >
            <div className="summary-notes-header">
              <h3>Notes</h3>
              <button
                type="button"
                className="ghost"
                onClick={onCloseSummaryNotes}
              >
                Close
              </button>
            </div>
            <p className="summary-notes-context">
              {formatEntityDisplayLabel(
                selectedSummaryNotesContext.row.engagementName,
                selectedSummaryNotesContext.row.engagementCode,
              )} / {formatEntityDisplayLabel(
                selectedSummaryNotesContext.row.activityName,
                selectedSummaryNotesContext.row.activityCode,
              )}
              {' '}on {SUMMARY_DAY_NAMES[selectedSummaryNotesContext.dayIndex]} ({formatMonthDay(selectedSummaryNotesContext.day.date)})
            </p>
            <div className="summary-notes-list">
              {selectedSummaryNotesContext.notes.map((note, index) => (
                <p key={`${note.startMinute}-${note.endMinute}-${index}`}>
                  {formatMinutesAsHours(note.durationMinutes)} Hours: {note.description}
                </p>
              ))}
            </div>
            <div className="summary-notes-actions">
              <button type="button" onClick={onCopySummaryNotes}>
                Copy
              </button>
            </div>
          </div>
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
  highlightedDates,
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
          const isInHighlightedWeek = highlightedDates.has(cell.date)
          const classes = [
            'mini-calendar-day',
            cell.isCurrentMonth ? 'current-month' : 'outside-month',
            isSelected ? 'is-selected' : '',
            isToday ? 'is-today' : '',
            hasEntries ? 'has-entries' : '',
            isInHighlightedWeek ? 'in-summary-week' : '',
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
                isInHighlightedWeek,
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

function TimelineBlockContent({
  label,
}: {
  label: string
}) {
  return (
    <span className="timeline-block-content">
      <span className="timeline-block-label">{label}</span>
    </span>
  )
}

function formatDiagnosticsTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString()
}

function formatLocalTime(value: Date): string {
  const hours = `${value.getHours()}`.padStart(2, '0')
  const minutes = `${value.getMinutes()}`.padStart(2, '0')
  return `${hours}:${minutes}`
}

function buildEntryDraftEndState(endMinute: number): Pick<EntryDraft, 'endTime' | 'preserveEndOfDay'> {
  if (endMinute === MINUTES_IN_DAY) {
    return {
      endTime: END_OF_DAY_INPUT_SENTINEL,
      preserveEndOfDay: true,
    }
  }

  return {
    endTime: minuteToTimeInput(endMinute),
    preserveEndOfDay: false,
  }
}

function buildEntryDraft(entry: TimelineEntry): EntryDraft {
  const endState = buildEntryDraftEndState(entry.endMinute)

  return {
    id: entry.id,
    date: entry.date,
    engagementId: entry.engagementId ?? '',
    activityId: entry.activityId ?? '',
    description: entry.description,
    startTime: minuteToTimeInput(entry.startMinute),
    ...endState,
  }
}

function resolveEntryDraftEndMinute(entryDraft: EntryDraft): number {
  if (entryDraft.preserveEndOfDay && entryDraft.endTime === END_OF_DAY_INPUT_SENTINEL) {
    return MINUTES_IN_DAY
  }

  return timeInputToMinute(entryDraft.endTime)
}

function generateSubmissionQueueId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `queue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function formatSubmissionQueueStateLabel(state: SubmissionQueueItemState): string {
  if (state === 'pending') {
    return 'Queued'
  }

  if (state === 'running') {
    return 'Processing'
  }

  if (state === 'success') {
    return 'Completed'
  }

  return 'Failed'
}

function formatSubmissionQueueSuccessMessage(createdEntryCount: number, completedAt: Date): string {
  return `Added ${createdEntryCount} new entr${createdEntryCount === 1 ? 'y' : 'ies'} on ${formatSubmissionQueueOutcomeTimestamp(completedAt)}.`
}

function formatSubmissionQueueOutcomeTimestamp(value: Date): string {
  const date = new Intl.DateTimeFormat('en-US', {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  }).format(value)
  const showMinutes = value.getMinutes() !== 0
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: showMinutes ? '2-digit' : undefined,
  }).format(value)
  return `${date} at ${time}`
}

function formatSubmissionQueueTimestamp(timestampMs: number): string {
  return formatSubmissionQueueOutcomeTimestamp(new Date(timestampMs))
}

function formatSubmissionQueueDuration(durationMs: number): string {
  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)}s`
  }

  const totalSeconds = durationMs / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds - minutes * 60

  return `${minutes}m ${seconds.toFixed(1)}s`
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

  if (normalized.includes('engagement name is required')) {
    return 'Engagement name is required.'
  }

  if (
    normalized.includes('engagement usage guidance is required')
    || normalized.includes('activity usage guidance is required')
    || normalized.includes('usage guidance is required')
  ) {
    return '"Describe when to use" is required for matching.'
  }

  if (normalized.includes('activity engagement and name are required')) {
    return 'Select an engagement and enter an activity name.'
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

function formatMinutesAsHours(minutes: number): string {
  return (minutes / 60).toFixed(2)
}

function formatMonthDay(date: string): string {
  const [yearToken, monthToken, dayToken] = date.split('-')
  const year = Number(yearToken)
  const monthIndex = Number(monthToken) - 1
  const day = Number(dayToken)
  const value = new Date(year, monthIndex, day)
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
  }).format(value)
}

function formatTimelineHeaderDate(date: string): TimelineHeaderDate {
  const value = new Date(`${date}T00:00:00`)
  return {
    monthDay: new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
    }).format(value),
    year: new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
    }).format(value),
    weekday: new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
    }).format(value),
  }
}

function formatSummaryNotesForClipboard(notes: TimelineWeeklySummaryNote[]): string {
  return notes
    .map((note) => `${formatMinutesAsHours(note.durationMinutes)} Hours: ${note.description}`)
    .join('\n')
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
  state: {
    isSelected: boolean
    isToday: boolean
    hasEntries: boolean
    isInHighlightedWeek: boolean
  },
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

  if (state.isInHighlightedWeek) {
    parts.push('in summary week')
  }

  return parts.join(', ')
}

function applyDragPreviewToTimelineEntries(
  entries: TimelineEntry[],
  dragState: TimelineDragState | null,
): TimelineEntry[] {
  if (!dragState || !dragState.isDragging) {
    return entries
  }

  const previewDuration = dragState.previewEndMinute - dragState.previewStartMinute
  return entries.map((entry) =>
    entry.id === dragState.entryId
      ? {
          ...entry,
          startMinute: dragState.previewStartMinute,
          endMinute: dragState.previewEndMinute,
          durationMinutes: previewDuration,
        }
      : entry,
  )
}

function snapMinute(value: number, increment: number): number {
  if (increment <= 0) {
    return value
  }

  return Math.round(value / increment) * increment
}

function clampStartMinuteForDuration(
  startMinute: number,
  durationMinutes: number,
  timelineWindow: TimelineWindow,
): number {
  const safeDuration = Math.max(durationMinutes, TIMELINE_DRAG_SNAP_MINUTES)
  const maxStartMinute = Math.max(
    timelineWindow.startMinute,
    timelineWindow.endMinute - safeDuration,
  )

  return Math.min(
    Math.max(startMinute, timelineWindow.startMinute),
    maxStartMinute,
  )
}

function clientYToTimelineMinute(
  clientY: number,
  grid: HTMLDivElement,
  timelineWindow: TimelineWindow,
): number {
  const gridRect = grid.getBoundingClientRect()
  const relativeY =
    clientY - gridRect.top + grid.scrollTop - TIMELINE_CANVAS_TOP_PADDING
  const pixelsPerMinute = PIXELS_PER_MINUTE > 0 ? PIXELS_PER_MINUTE : 1

  return timelineWindow.startMinute + (relativeY / pixelsPerMinute)
}

function positionTimelineEntries(
  entries: TimelineEntry[],
  timelineWindow: TimelineWindow,
  options?: PositionTimelineEntriesOptions,
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
    let layoutGroup = group
    const preferredLaneByEntryId = options?.preferredLaneByEntryId
    const preferredLaneOrder = options?.preferredLaneOrder ?? []

    if (
      preferredLaneByEntryId
      && preferredLaneByEntryId.size > 0
      && preferredLaneOrder.length > 0
    ) {
      const groupEntryIds = new Set(group.map((entry) => entry.entry.id))
      const orderedGroupEntryIds = preferredLaneOrder.filter((entryId) => groupEntryIds.has(entryId))

      for (const entryId of orderedGroupEntryIds) {
        const preferredLaneIndex = preferredLaneByEntryId.get(entryId)
        if (
          typeof preferredLaneIndex !== 'number'
          || preferredLaneIndex < 0
          || preferredLaneIndex >= laneCount
        ) {
          continue
        }

        const preferredEntry = layoutGroup.find((entry) => entry.entry.id === entryId) ?? null
        if (!preferredEntry || preferredEntry.laneIndex === preferredLaneIndex) {
          continue
        }

        const currentLaneIndex = preferredEntry.laneIndex
        layoutGroup = layoutGroup.map((groupEntry) => {
          if (groupEntry.entry.id === entryId) {
            return {
              ...groupEntry,
              laneIndex: preferredLaneIndex,
            }
          }

          if (groupEntry.laneIndex === preferredLaneIndex) {
            return {
              ...groupEntry,
              laneIndex: currentLaneIndex,
            }
          }

          return groupEntry
        })
      }
    }

    const lockedEntryId = options?.lockedEntryId
    const lockedLaneIndex = options?.lockedLaneIndex
    const lockedEntry = lockedEntryId
      ? layoutGroup.find((entry) => entry.entry.id === lockedEntryId) ?? null
      : null

    if (
      lockedEntry
      && typeof lockedLaneIndex === 'number'
      && lockedLaneIndex >= 0
      && lockedLaneIndex < laneCount
      && lockedEntry.laneIndex !== lockedLaneIndex
    ) {
      const currentLaneIndex = lockedEntry.laneIndex
      layoutGroup = layoutGroup.map((groupEntry) => {
        if (groupEntry.entry.id === lockedEntry.entry.id) {
          return {
            ...groupEntry,
            laneIndex: lockedLaneIndex,
          }
        }

        if (groupEntry.laneIndex === lockedLaneIndex) {
          return {
            ...groupEntry,
            laneIndex: currentLaneIndex,
          }
        }

        return groupEntry
      })
    }

    const laneGapPercent = laneCount > 1 ? TIMELINE_OVERLAP_GAP_PERCENT : 0
    const totalGapPercent = laneGapPercent * Math.max(0, laneCount - 1)
    const widthPercent = (100 - totalGapPercent) / laneCount

    for (const groupEntry of layoutGroup) {
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

function deriveTimelineAccentColor(backgroundHex: string): string {
  const normalized = normalizeColorHexInput(backgroundHex) ?? TIMELINE_NEUTRAL_COLOR
  const red = Number.parseInt(normalized.slice(1, 3), 16)
  const green = Number.parseInt(normalized.slice(3, 5), 16)
  const blue = Number.parseInt(normalized.slice(5, 7), 16)
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255
  const average = (red + green + blue) / 3
  const saturateChannel = (value: number) =>
    clampColorChannel(average + ((value - average) * TIMELINE_ACCENT_SATURATION_BOOST))

  const saturatedRed = saturateChannel(red)
  const saturatedGreen = saturateChannel(green)
  const saturatedBlue = saturateChannel(blue)

  if (luminance >= TIMELINE_ACCENT_BRIGHTNESS_THRESHOLD) {
    const darkenedRed = clampColorChannel(saturatedRed * TIMELINE_ACCENT_DARKEN_FACTOR)
    const darkenedGreen = clampColorChannel(saturatedGreen * TIMELINE_ACCENT_DARKEN_FACTOR)
    const darkenedBlue = clampColorChannel(saturatedBlue * TIMELINE_ACCENT_DARKEN_FACTOR)

    return `#${colorChannelToHex(darkenedRed)}${colorChannelToHex(darkenedGreen)}${colorChannelToHex(darkenedBlue)}`
  }

  const brightenedRed = clampColorChannel(
    saturatedRed + ((255 - saturatedRed) * TIMELINE_ACCENT_LIGHTEN_RATIO),
  )
  const brightenedGreen = clampColorChannel(
    saturatedGreen + ((255 - saturatedGreen) * TIMELINE_ACCENT_LIGHTEN_RATIO),
  )
  const brightenedBlue = clampColorChannel(
    saturatedBlue + ((255 - saturatedBlue) * TIMELINE_ACCENT_LIGHTEN_RATIO),
  )

  return `#${colorChannelToHex(brightenedRed)}${colorChannelToHex(brightenedGreen)}${colorChannelToHex(brightenedBlue)}`
}

function clampColorChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function colorChannelToHex(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase()
}

function normalizeCodeTags(tags: string[]): string[] {
  return tags
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

function formatActivityCount(count: number): string {
  return `${count} ${count === 1 ? 'activity' : 'activities'}`
}

function normalizeDisplayText(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function formatEntityPrimaryLabel(
  name: string | null | undefined,
  code: string | null | undefined,
  fallback = 'Uncategorized',
): string {
  return normalizeDisplayText(name) ?? normalizeDisplayText(code) ?? fallback
}

function formatEntityDisplayLabel(
  name: string | null | undefined,
  code: string | null | undefined,
  fallback = 'Uncategorized',
): string {
  const primary = formatEntityPrimaryLabel(name, code, fallback)
  const normalizedCode = normalizeDisplayText(code)

  if (!normalizedCode || normalizedCode.toUpperCase() === primary.toUpperCase()) {
    return primary
  }

  return `${primary} (${normalizedCode})`
}

function formatSummaryCodeValue(code: string | null | undefined, isUncategorized: boolean): string {
  if (isUncategorized) {
    return 'UNCAT'
  }

  return normalizeDisplayText(code) ?? ''
}

function getTimelineBlockReviewLabel(warningFlags: WarningType[]): string | null {
  const hasLowConfidence = warningFlags.includes('low_confidence')
  const hasUnmatched = warningFlags.includes('unmatched')

  if (hasLowConfidence && hasUnmatched) {
    return 'Low confidence and uncategorized'
  }

  if (hasLowConfidence) {
    return 'Low confidence'
  }

  if (hasUnmatched) {
    return 'Uncategorized'
  }

  return null
}

function buildTimelineBlockTitle(
  fullLabel: string,
  description: string,
  reviewLabel: string | null,
): string {
  const reviewLine = reviewLabel ? `\nReview needed: ${reviewLabel}` : ''
  return `${fullLabel}\n${description}${reviewLine}`
}

function buildTimelineBlockAriaLabel(
  fullLabel: string,
  description: string,
  reviewLabel: string | null,
): string {
  const reviewSentence = reviewLabel ? ` Review needed: ${reviewLabel}.` : ''
  return `${fullLabel}. ${description}.${reviewSentence}`
}

function buildTimelineBlockLabel(
  entry: TimelineEntry,
  widthPercent: number,
  blockHeight: number,
): TimelineLabel {
  const engagementPrimary = formatEntityPrimaryLabel(
    entry.engagementName,
    entry.engagementCode,
    'Uncategorized',
  )
  const activityPrimary = formatEntityPrimaryLabel(
    entry.activityName,
    entry.activityCode,
    'Uncategorized',
  )
  const fullLabelBase = `${formatEntityDisplayLabel(entry.engagementName, entry.engagementCode)} | ${formatEntityDisplayLabel(entry.activityName, entry.activityCode)}`

  if (widthPercent < 36 || blockHeight < 28) {
    return {
      label: activityPrimary,
      fullLabel: fullLabelBase,
      tier: 3,
    }
  }

  if (widthPercent < 58 || blockHeight < 38) {
    return {
      label: `${engagementPrimary} | ${activityPrimary}`,
      fullLabel: fullLabelBase,
      tier: 2,
    }
  }

  return {
    label: fullLabelBase,
    fullLabel: fullLabelBase,
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

