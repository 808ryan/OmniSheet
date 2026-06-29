import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { emit } from '@tauri-apps/api/event'

import {
  engagementList,
  interpretTextMessage,
  quickAddHideWindow,
  quickAddShowMainWindow,
  quickAddSuggestions,
  settingsGetStatus,
  timelineCreateEntry,
} from './lib/api'
import { QUICK_ADD_OPEN_TIMELINE_EVENT, QUICK_ADD_SUBMITTED_EVENT } from './lib/events'
import {
  buildQuickEntryModel,
  QUICK_ENTRY_DEFAULT_DURATION_MINUTES,
  QUICK_ENTRY_DRAG_ACTIVATION_PX,
  quickEntryActivityKey,
  quickEntryDurationFromDrag,
  resolveQuickEntryCreateWindow,
  sanitizeQuickAddPreferences,
} from './lib/quickEntry'
import type { QuickEntryDragState } from './lib/quickEntry'
import { isTauriRuntime } from './lib/runtime'
import { formatDate } from './lib/time'
import type {
  Activity,
  Engagement,
  OpenAiModelId,
  QuickAddSuggestion,
  SettingsStatus,
} from './lib/types'
import { QuickEntryTileList } from './QuickEntryTileList'
import './QuickAdd.css'

type QuickAddStatus = 'idle' | 'loading' | 'submitting' | 'success' | 'error'

interface QuickEntryScrollMetrics {
  canScroll: boolean
  thumbTopPct: number
  thumbHeightPct: number
}

const DEFAULT_OPENAI_MODEL: OpenAiModelId = 'gpt-5.5-instant'
const LLM_ENTRY_EXAMPLE_TEXT = 'Spent an hour on Non-Rev ITACs...'
const MISSING_OPENAI_KEY_HINT = 'No API key is configured in settings'

function QuickAdd() {
  const tauriRuntime = isTauriRuntime()
  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus | null>(null)
  const [engagements, setEngagements] = useState<Engagement[]>([])
  const [quickAddSuggestionItems, setQuickAddSuggestionItems] = useState<QuickAddSuggestion[]>([])
  const [quickAddSuggestedKeys, setQuickAddSuggestedKeys] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState<QuickAddStatus>(tauriRuntime ? 'loading' : 'error')
  const [statusMessage, setStatusMessage] = useState(
    tauriRuntime
      ? 'Loading Quick Entry...'
      : 'Quick Add requires the Tauri desktop runtime.',
  )
  const [dataError, setDataError] = useState<string | null>(null)
  const [quickBlockDragState, setQuickBlockDragState] = useState<QuickEntryDragState | null>(null)
  const [quickAddScrollMetrics, setQuickAddScrollMetrics] = useState<QuickEntryScrollMetrics>({
    canScroll: false,
    thumbTopPct: 0,
    thumbHeightPct: 100,
  })

  const quickBlockDragStateRef = useRef<QuickEntryDragState | null>(null)
  const quickAddScrollRef = useRef<HTMLDivElement | null>(null)
  const statusRef = useRef(status)

  useEffect(() => {
    statusRef.current = status
  }, [status])

  const updateSuggestedKeys = useCallback((suggestions: QuickAddSuggestion[]) => {
    setQuickAddSuggestedKeys((previous) => {
      const incomingKeys = suggestions.map((suggestion) =>
        quickEntryActivityKey(suggestion.engagementId, suggestion.activityId),
      )

      if (previous.length === 0) {
        return incomingKeys
      }

      const next = previous.slice()
      const seenKeys = new Set(next)

      for (const key of incomingKeys) {
        if (!seenKeys.has(key)) {
          next.push(key)
          seenKeys.add(key)
        }
      }

      return next
    })
  }, [])

  const loadQuickAddData = useCallback(async () => {
    if (!tauriRuntime) {
      return
    }

    setStatus((previous) => previous === 'submitting' ? previous : 'loading')
    setStatusMessage((previous) => statusRef.current === 'submitting' ? previous : 'Loading Quick Entry...')
    setDataError(null)

    try {
      const [nextSettingsStatus, nextEngagements, nextSuggestions] = await Promise.all([
        settingsGetStatus(),
        engagementList(),
        quickAddSuggestions(),
      ])

      setSettingsStatus(nextSettingsStatus)
      setEngagements(nextEngagements)
      setQuickAddSuggestionItems(nextSuggestions.suggestions)
      updateSuggestedKeys(nextSuggestions.suggestions)

      setStatus((previous) => previous === 'submitting' ? previous : 'idle')
      setStatusMessage((previous) => statusRef.current === 'submitting' ? previous : '')
    } catch (error) {
      const messageText = extractErrorMessage(error)
      setDataError(messageText)
      setStatus('error')
      setStatusMessage(messageText)
    }
  }, [tauriRuntime, updateSuggestedKeys])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadQuickAddData()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadQuickAddData])

  useEffect(() => {
    const handleFocus = () => {
      void loadQuickAddData()
    }

    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [loadQuickAddData])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        void quickAddHideWindow()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    const handleBlur = () => {
      window.setTimeout(() => {
        if (statusRef.current !== 'submitting' && !document.hasFocus()) {
          void quickAddHideWindow()
        }
      }, 120)
    }

    window.addEventListener('blur', handleBlur)
    return () => window.removeEventListener('blur', handleBlur)
  }, [])

  const quickAddPreferences = useMemo(
    () => sanitizeQuickAddPreferences(settingsStatus?.quickAddPreferences, engagements),
    [engagements, settingsStatus?.quickAddPreferences],
  )
  const quickEntryModel = useMemo(
    () => buildQuickEntryModel({
      engagements,
      preferences: quickAddPreferences,
      suggestions: quickAddSuggestionItems,
      suggestedKeys: quickAddSuggestedKeys,
      search: '',
    }),
    [
      engagements,
      quickAddPreferences,
      quickAddSuggestedKeys,
      quickAddSuggestionItems,
    ],
  )

  const updateQuickAddScrollMetrics = useCallback(() => {
    const node = quickAddScrollRef.current

    if (!node) {
      setQuickAddScrollMetrics((previous) => (
        previous.canScroll
          ? { canScroll: false, thumbTopPct: 0, thumbHeightPct: 100 }
          : previous
      ))
      return
    }

    const maxScrollTop = Math.max(node.scrollHeight - node.clientHeight, 0)
    const canScroll = maxScrollTop > 1

    if (!canScroll || node.scrollHeight <= 0 || node.clientHeight <= 0) {
      setQuickAddScrollMetrics((previous) => (
        previous.canScroll
          ? { canScroll: false, thumbTopPct: 0, thumbHeightPct: 100 }
          : previous
      ))
      return
    }

    const thumbHeightPct = Math.min(100, Math.max((node.clientHeight / node.scrollHeight) * 100, 18))
    const maxThumbTopPct = Math.max(100 - thumbHeightPct, 0)
    const thumbTopPct = Math.min(maxThumbTopPct, Math.max(0, (node.scrollTop / maxScrollTop) * maxThumbTopPct))

    setQuickAddScrollMetrics((previous) => {
      if (
        previous.canScroll === canScroll
        && previous.thumbTopPct === thumbTopPct
        && previous.thumbHeightPct === thumbHeightPct
      ) {
        return previous
      }

      return {
        canScroll,
        thumbTopPct,
        thumbHeightPct,
      }
    })
  }, [])

  useLayoutEffect(() => {
    const node = quickAddScrollRef.current
    if (!node) {
      return undefined
    }

    let animationFrame: number | null = null
    const scheduleUpdate = () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame)
      }

      animationFrame = window.requestAnimationFrame(updateQuickAddScrollMetrics)
    }

    scheduleUpdate()

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleUpdate)

    resizeObserver?.observe(node)
    if (node.firstElementChild) {
      resizeObserver?.observe(node.firstElementChild)
    }

    window.addEventListener('resize', scheduleUpdate)

    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame)
      }
      resizeObserver?.disconnect()
      window.removeEventListener('resize', scheduleUpdate)
    }
  }, [quickEntryModel.groups, updateQuickAddScrollMetrics])

  const setQuickBlockDragStateWithRef = useCallback(
    (updater: (previous: QuickEntryDragState | null) => QuickEntryDragState | null) => {
      setQuickBlockDragState((previous) => {
        const next = updater(previous)
        quickBlockDragStateRef.current = next
        return next
      })
    },
    [],
  )

  const submitCurrentMessage = useCallback(async () => {
    const rawText = message.trim()
    if (rawText.length === 0 || statusRef.current === 'submitting') {
      return
    }

    if (settingsStatus?.hasOpenAiKey !== true) {
      setStatus('idle')
      setStatusMessage('')
      return
    }

    const submittedAt = new Date()
    setStatus('submitting')
    setStatusMessage('Adding entry...')

    try {
      const result = await interpretTextMessage({
        rawText,
        openAiModel: settingsStatus.selectedOpenAiModel ?? DEFAULT_OPENAI_MODEL,
        clientTimestampIso: submittedAt.toISOString(),
        clientLocalDate: formatDate(submittedAt),
        clientLocalTime: formatLocalTime(submittedAt),
        clientUtcOffsetMinutes: -submittedAt.getTimezoneOffset(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        captureSource: 'text',
      })

      setMessage('')
      setStatus('success')
      setStatusMessage(
        result.createdEntryIds.length === 0
          ? 'No open gaps found.'
          : `Added ${result.createdEntryIds.length} entr${result.createdEntryIds.length === 1 ? 'y' : 'ies'}.`,
      )
      await emit(QUICK_ADD_SUBMITTED_EVENT, {
        createdEntryIds: result.createdEntryIds,
        touchedMonthKeys: result.touchedMonthKeys,
      })
      await quickAddHideWindow()
    } catch (error) {
      setStatus('error')
      setStatusMessage(extractErrorMessage(error))
    }
  }, [message, settingsStatus])

  const createQuickBlockEntry = useCallback(async (
    engagement: Engagement,
    activity: Activity,
    durationMinutes: number,
  ) => {
    if (statusRef.current === 'submitting' || activity.isActive === false) {
      return
    }

    const date = formatDate(new Date())
    const { startMinute, endMinute } = resolveQuickEntryCreateWindow(durationMinutes)
    setStatus('submitting')
    setStatusMessage(`Adding ${activity.name || activity.code || 'entry'}...`)

    try {
      const result = await timelineCreateEntry({
        date,
        startMinute,
        endMinute,
        engagementId: engagement.id,
        activityId: activity.id,
        description: '',
      })

      setStatus('success')
      setStatusMessage(`Added ${activity.name || activity.code || 'entry'}.`)
      await emit(QUICK_ADD_SUBMITTED_EVENT, {
        createdEntryIds: [result.id],
        touchedMonthKeys: [monthKeyFromDate(date)],
      })
      await quickAddHideWindow()
    } catch (error) {
      setStatus('error')
      setStatusMessage(extractErrorMessage(error))
    }
  }, [])

  const onQuickBlockActivityPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    engagement: Engagement,
    activity: Activity,
  ) => {
    if (event.button !== 0 || statusRef.current === 'submitting' || activity.isActive === false) {
      return
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setQuickBlockDragStateWithRef(() => ({
      engagementId: engagement.id,
      activityId: activity.id,
      activityName: activity.name,
      pointerId: event.pointerId,
      originClientX: event.clientX,
      currentClientX: event.clientX,
      durationMinutes: QUICK_ENTRY_DEFAULT_DURATION_MINUTES,
      isDragging: false,
    }))
  }

  const onQuickBlockActivityPointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const current = quickBlockDragStateRef.current
    if (!current || current.pointerId !== event.pointerId) {
      return
    }

    const nextDuration = quickEntryDurationFromDrag(
      current.originClientX,
      event.clientX,
    )
    const nextIsDragging =
      current.isDragging
      || Math.abs(event.clientX - current.originClientX) >= QUICK_ENTRY_DRAG_ACTIVATION_PX

    setQuickBlockDragStateWithRef(() => ({
      ...current,
      currentClientX: event.clientX,
      durationMinutes: nextDuration,
      isDragging: nextIsDragging,
    }))
  }

  const onQuickBlockActivityPointerUp = (
    event: ReactPointerEvent<HTMLButtonElement>,
    engagement: Engagement,
    activity: Activity,
  ) => {
    const current = quickBlockDragStateRef.current
    if (!current || current.pointerId !== event.pointerId) {
      return
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    event.preventDefault()
    setQuickBlockDragStateWithRef(() => null)
    void createQuickBlockEntry(engagement, activity, current.durationMinutes)
  }

  const onQuickBlockActivityPointerCancel = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const current = quickBlockDragStateRef.current
    if (!current || current.pointerId !== event.pointerId) {
      return
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    setQuickBlockDragStateWithRef(() => null)
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void submitCurrentMessage()
  }

  const openMainTimeline = useCallback(async () => {
    if (statusRef.current === 'submitting') {
      return
    }

    try {
      await quickAddShowMainWindow()
      await emit(QUICK_ADD_OPEN_TIMELINE_EVENT)
    } catch (error) {
      setStatus('error')
      setStatusMessage(extractErrorMessage(error))
    }
  }, [])

  const onMessageKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== 'Enter'
      || event.shiftKey
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.nativeEvent.isComposing
    ) {
      return
    }

    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  const canSubmitText =
    status !== 'submitting'
    && settingsStatus?.hasOpenAiKey === true
    && message.trim().length > 0
  const sendButtonTitle = settingsStatus === null
    ? 'Checking API key status'
    : settingsStatus.hasOpenAiKey
      ? 'Send entry'
      : MISSING_OPENAI_KEY_HINT
  const emptyMessage = status === 'loading'
    ? 'Loading activities...'
    : quickEntryModel.allActivities.length === 0
      ? 'No active activities yet.'
      : quickEntryModel.orderedActivities.length === 0
        ? 'All Quick Entry items are hidden.'
        : 'No activities to show.'
  const shouldShowStatus = status !== 'idle' && statusMessage.trim().length > 0

  return (
    <main className="quick-add-shell quick-add-palette" aria-busy={status === 'loading' || status === 'submitting'}>
      <h1 className="sr-only">Quick Add</h1>

      <section className="quick-add-llm-panel" aria-labelledby="quick-add-llm-title">
        <div className="quick-add-llm-header">
          <h2 id="quick-add-llm-title" className="quick-add-section-title">LLM Entry</h2>
          <button
            type="button"
            className="quick-add-home-button"
            onClick={() => void openMainTimeline()}
            disabled={status === 'submitting'}
            aria-label="Open OmniSheet timeline"
            title="Open OmniSheet timeline"
          >
            <svg
              className="quick-add-home-icon"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M4.25 10.75 12 4.25l7.75 6.5v8.75H4.25z" />
            </svg>
          </button>
        </div>
        <form className="quick-add-command" onSubmit={onSubmit}>
          <label className="quick-add-entry-bar">
            <span className="sr-only">Describe a timesheet entry</span>
            <textarea
              value={message}
              onKeyDown={onMessageKeyDown}
              onChange={(event) => {
                setMessage(event.target.value)
                if (statusRef.current === 'submitting') {
                  return
                }

                setStatus('idle')
                setStatusMessage('')
              }}
              placeholder={LLM_ENTRY_EXAMPLE_TEXT}
              rows={1}
              disabled={status === 'submitting'}
              autoFocus
            />
            <span className="quick-add-send-hint" title={sendButtonTitle}>
              <button
                type="submit"
                className="quick-add-send-button"
                disabled={!canSubmitText}
                aria-label="Send entry"
              >
                <svg
                  className="quick-add-send-icon"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M8 13V3.75" />
                  <path d="M4.25 7.5 8 3.75 11.75 7.5" />
                </svg>
              </button>
            </span>
          </label>
        </form>
      </section>

      {shouldShowStatus ? (
        <p className={`quick-add-status ${status}`}>
          {statusMessage}
        </p>
      ) : null}

      <section className="quick-add-tiles-panel" aria-label="Quick Entry">
        <div className="quick-add-tiles-header">
          <h2 className="quick-add-section-title">Quick Entry</h2>
        </div>
        <QuickEntryTileList
          groups={quickEntryModel.groups}
          dragState={quickBlockDragState}
          emptyMessage={emptyMessage}
          errorMessage={dataError}
          disabled={status === 'submitting' || status === 'loading'}
          scrollRef={quickAddScrollRef}
          scrollMetrics={quickAddScrollMetrics}
          onScroll={updateQuickAddScrollMetrics}
          onPointerDown={onQuickBlockActivityPointerDown}
          onPointerMove={onQuickBlockActivityPointerMove}
          onPointerUp={onQuickBlockActivityPointerUp}
          onPointerCancel={onQuickBlockActivityPointerCancel}
          onCreate={createQuickBlockEntry}
        />
      </section>
    </main>
  )
}

function formatLocalTime(value: Date): string {
  const hour = `${value.getHours()}`.padStart(2, '0')
  const minute = `${value.getMinutes()}`.padStart(2, '0')
  return `${hour}:${minute}`
}

function monthKeyFromDate(date: string): string {
  return date.slice(0, 7)
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }

  return 'Something went wrong.'
}

export default QuickAdd
