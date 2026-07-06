import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'

import {
  formatEntityDisplayLabel,
  formatEntityPrimaryLabel,
  formatQuickEntryDuration,
  QUICK_ENTRY_DEFAULT_DURATION_MINUTES,
  QUICK_ENTRY_NEUTRAL_COLOR,
  quickEntryDurationProgress,
} from './lib/quickEntry'
import type {
  QuickEntryActivityGroup,
  QuickEntryDragState,
} from './lib/quickEntry'
import type { Activity, Engagement } from './lib/types'
import { QuickEntryScrollIndicator } from './QuickEntryScrollIndicator'
import type { QuickEntryScrollMetrics } from './QuickEntryScrollIndicator'

interface QuickEntryTileListProps {
  groups: QuickEntryActivityGroup[]
  dragState: QuickEntryDragState | null
  emptyMessage: string
  errorMessage?: string | null
  disabled?: boolean
  scrollRef?: RefObject<HTMLDivElement | null>
  scrollMetrics?: QuickEntryScrollMetrics
  onScroll?: () => void
  onPointerDown: (
    event: ReactPointerEvent<HTMLButtonElement>,
    engagement: Engagement,
    activity: Activity,
  ) => void
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerUp: (
    event: ReactPointerEvent<HTMLButtonElement>,
    engagement: Engagement,
    activity: Activity,
  ) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onCreate: (engagement: Engagement, activity: Activity, durationMinutes: number) => void
}

export function QuickEntryTileList({
  groups,
  dragState,
  emptyMessage,
  errorMessage,
  disabled = false,
  scrollRef,
  scrollMetrics,
  onScroll,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onCreate,
}: QuickEntryTileListProps) {
  if (errorMessage) {
    return <p className="quick-add-error" role="status">{errorMessage}</p>
  }

  if (groups.length === 0) {
    return <p className="quick-add-empty">{emptyMessage}</p>
  }

  return (
    <div className="quick-add-scroll-frame">
      <div
        ref={scrollRef}
        className="quick-add-scroll"
        onScroll={onScroll}
      >
        <div className="quick-add-list">
          {groups.map((group) => {
            const engagementColor = group.engagement.colorHex ?? QUICK_ENTRY_NEUTRAL_COLOR

            return (
              <section
                key={group.engagement.id}
                className="quick-add-group"
                style={{
                  '--quick-add-color': engagementColor,
                } as CSSProperties}
              >
                <div
                  className="quick-add-group-header"
                  title={formatEntityDisplayLabel(
                    group.engagement.name,
                    group.engagement.code,
                    'Engagement',
                  )}
                >
                  <span>{formatEntityPrimaryLabel(
                    group.engagement.name,
                    group.engagement.code,
                    'Engagement',
                  )}</span>
                </div>
                <div className="quick-add-grid">
                  {group.activities.map(({ activity, engagement }) => {
                    const activityColor = activity.colorHex ?? engagementColor
                    const isDraggingActivity =
                      dragState?.activityId === activity.id
                      && dragState.engagementId === engagement.id
                    const durationMinutes = isDraggingActivity
                      ? dragState.durationMinutes
                      : QUICK_ENTRY_DEFAULT_DURATION_MINUTES
                    const activityLabel = activity.name || activity.code
                    const fullActivityLabel = formatEntityDisplayLabel(activity.name, activity.code)

                    return (
                      <button
                        key={activity.id}
                        type="button"
                        className={`quick-add-tile ${isDraggingActivity ? 'dragging' : ''}`}
                        disabled={disabled}
                        onPointerDown={(event) =>
                          onPointerDown(event, engagement, activity)
                        }
                        onPointerMove={onPointerMove}
                        onPointerUp={(event) =>
                          onPointerUp(event, engagement, activity)
                        }
                        onPointerCancel={onPointerCancel}
                        onKeyDown={(event) =>
                          handleTileKeyDown(event, engagement, activity, onCreate)
                        }
                        aria-label={`Add ${fullActivityLabel} for ${formatQuickEntryDuration(durationMinutes)}`}
                        title={fullActivityLabel}
                        style={{
                          '--quick-add-color': activityColor,
                          '--quick-add-duration-progress': `${quickEntryDurationProgress(durationMinutes)}%`,
                        } as CSSProperties}
                      >
                        <span className="quick-add-tile-main">
                          <strong>{activityLabel}</strong>
                        </span>
                        {isDraggingActivity ? (
                          <span className="quick-add-duration">
                            {formatQuickEntryDuration(durationMinutes)}
                          </span>
                        ) : null}
                        {isDraggingActivity ? (
                          <span className="quick-add-duration-track" aria-hidden="true">
                            <span />
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      </div>
      {scrollRef && scrollMetrics ? (
        <QuickEntryScrollIndicator scrollRef={scrollRef} metrics={scrollMetrics} />
      ) : null}
    </div>
  )
}

function handleTileKeyDown(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  engagement: Engagement,
  activity: Activity,
  onCreate: (engagement: Engagement, activity: Activity, durationMinutes: number) => void,
) {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return
  }

  event.preventDefault()
  onCreate(engagement, activity, QUICK_ENTRY_DEFAULT_DURATION_MINUTES)
}
