import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'

import { PlusIcon, SearchIcon } from './InterfaceIcons'
import {
  formatEntityDisplayLabel,
  formatEntityPrimaryLabel,
} from './lib/quickEntry'
import type { QuickEntryActivityView } from './lib/quickEntry'
import './ActivityCommandBar.css'

const DEFAULT_RESULT_LIMIT = 7

const DURATION_OPTIONS = [15, 30, 45, 60, 90, 120] as const

interface ActivityCommandBarProps {
  activities: QuickEntryActivityView[]
  disabled?: boolean
  autoFocus?: boolean
  placeholder?: string
  ariaLabel?: string
  actionLabel?: string
  emptyMessage?: string
  initialDurationMinutes?: number
  fixedDurationMinutes?: number
  showDuration?: boolean
  contextLabel?: string
  clearAfterSubmit?: boolean
  resultLimit?: number
  resultsMaterial?: 'translucent' | 'opaque'
  actionIcon?: 'plus'
  onSubmit: (activity: QuickEntryActivityView, durationMinutes: number) => void | Promise<void>
  onCancel?: () => void
}

export function ActivityCommandBar({
  activities,
  disabled = false,
  autoFocus = false,
  placeholder = 'Search activities',
  ariaLabel = 'Search activities',
  actionLabel = 'Add',
  emptyMessage = 'No matching activities.',
  initialDurationMinutes = 30,
  fixedDurationMinutes,
  showDuration = true,
  contextLabel,
  clearAfterSubmit = true,
  resultLimit = DEFAULT_RESULT_LIMIT,
  resultsMaterial = 'translucent',
  actionIcon,
  onSubmit,
  onCancel,
}: ActivityCommandBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listboxId = useId()
  const [query, setQuery] = useState('')
  const [durationMinutes, setDurationMinutes] = useState(initialDurationMinutes)
  const [isOpen, setIsOpen] = useState(autoFocus)
  const [activeIndex, setActiveIndex] = useState(0)

  const results = useMemo(
    () => rankActivityCommandResults(activities, query).slice(0, Math.max(1, resultLimit)),
    [activities, query, resultLimit],
  )
  const resolvedActiveIndex = Math.min(activeIndex, Math.max(0, results.length - 1))

  useEffect(() => {
    if (!autoFocus) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [autoFocus])

  const selectedDurationMinutes = fixedDurationMinutes ?? durationMinutes

  const submitActivity = (activity: QuickEntryActivityView | undefined) => {
    if (!activity || disabled) {
      return
    }

    void onSubmit(activity, selectedDurationMinutes)
    if (clearAfterSubmit) {
      setQuery('')
      setActiveIndex(0)
    }
  }

  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    submitActivity(results[resolvedActiveIndex] ?? results[0])
  }

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setQuery('')
      setIsOpen(false)
      onCancel?.()
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIsOpen(true)
      if (results.length === 0) {
        return
      }
      setActiveIndex(Math.min(results.length - 1, resolvedActiveIndex + 1))
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setIsOpen(true)
      if (results.length === 0) {
        return
      }
      setActiveIndex(Math.max(0, resolvedActiveIndex - 1))
    }
  }

  const activeResult = results[resolvedActiveIndex] ?? null

  return (
    <form
      className={`activity-command results-${resultsMaterial}`}
      onSubmit={onFormSubmit}
      onFocus={() => setIsOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setIsOpen(false)
        }
      }}
    >
      {contextLabel ? <p className="activity-command-context">{contextLabel}</p> : null}
      <div className="activity-command-controls">
        <div className="activity-command-search-shell">
          <SearchIcon className="activity-command-search-icon" />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-label={ariaLabel}
            aria-autocomplete="list"
            aria-expanded={isOpen}
            aria-controls={listboxId}
            aria-activedescendant={
              isOpen && activeResult ? `${listboxId}-${activeResult.activity.id}` : undefined
            }
            value={query}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
              setIsOpen(true)
            }}
            onKeyDown={onInputKeyDown}
          />
        </div>
        {showDuration && fixedDurationMinutes === undefined ? (
          <select
            className="activity-command-duration"
            value={durationMinutes}
            onChange={(event) => setDurationMinutes(Number(event.target.value))}
            disabled={disabled}
            aria-label="Entry duration"
          >
            {DURATION_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>{formatDuration(minutes)}</option>
            ))}
          </select>
        ) : showDuration && fixedDurationMinutes !== undefined ? (
          <span className="activity-command-fixed-duration">
            {formatDuration(fixedDurationMinutes)}
          </span>
        ) : null}
      </div>

      {isOpen ? (
        <div className="activity-command-results" id={listboxId} role="listbox">
          {results.length === 0 ? (
            <p className="activity-command-empty">{emptyMessage}</p>
          ) : results.map((item, index) => {
            const isActive = index === resolvedActiveIndex
            const activityLabel = formatEntityPrimaryLabel(
              item.activity.name,
              item.activity.code,
              'Activity',
            )
            const engagementLabel = formatEntityDisplayLabel(
              item.engagement.name,
              item.engagement.code,
              'Engagement',
            )

            return (
              <button
                id={`${listboxId}-${item.activity.id}`}
                key={`${item.engagement.id}:${item.activity.id}`}
                type="button"
                role="option"
                aria-selected={isActive}
                aria-label={`${actionLabel} ${activityLabel} for ${engagementLabel}`}
                className={`activity-command-result ${isActive ? 'is-active' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => submitActivity(item)}
                disabled={disabled}
              >
                <span
                  className="activity-command-result-accent"
                  style={{ backgroundColor: item.activity.colorHex ?? item.engagement.colorHex ?? undefined }}
                  aria-hidden="true"
                />
                <span className="activity-command-result-copy">
                  <strong>{activityLabel}</strong>
                  <small>{engagementLabel}</small>
                </span>
                <span
                  className={`activity-command-result-action ${actionIcon ? 'is-icon' : ''}`}
                  aria-hidden="true"
                >
                  {actionIcon === 'plus'
                    ? <PlusIcon className="activity-command-result-action-icon" />
                    : actionLabel}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </form>
  )
}

function rankActivityCommandResults(
  activities: QuickEntryActivityView[],
  query: string,
): QuickEntryActivityView[] {
  const terms = normalizeSearchText(query).split(' ').filter(Boolean)
  if (terms.length === 0) {
    return activities
  }

  return activities
    .map((item, sourceIndex) => ({
      item,
      sourceIndex,
      score: scoreActivityCommandResult(item, terms),
    }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex)
    .map((candidate) => candidate.item)
}

function scoreActivityCommandResult(item: QuickEntryActivityView, terms: string[]): number {
  const activityName = normalizeSearchText(item.activity.name)
  const activityCode = normalizeSearchText(item.activity.code ?? '')
  const engagementName = normalizeSearchText(item.engagement.name)
  const engagementCode = normalizeSearchText(item.engagement.code ?? '')
  const secondary = normalizeSearchText([
    ...item.activity.tags,
    ...item.engagement.tags,
    item.activity.describeWhenToUse,
    item.engagement.describeWhenToUse,
  ].filter(Boolean).join(' '))
  const haystack = [activityName, activityCode, engagementName, engagementCode, secondary].join(' ')

  if (!terms.every((term) => haystack.includes(term))) {
    return -1
  }

  return terms.reduce((score, term) => {
    if (activityName === term || activityCode === term) {
      return score + 100
    }
    if (activityName.startsWith(term) || activityCode.startsWith(term)) {
      return score + 60
    }
    if (activityName.includes(term) || activityCode.includes(term)) {
      return score + 40
    }
    if (engagementName.startsWith(term) || engagementCode.startsWith(term)) {
      return score + 24
    }
    if (engagementName.includes(term) || engagementCode.includes(term)) {
      return score + 16
    }
    return score + 6
  }, 0)
}

function normalizeSearchText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
}
