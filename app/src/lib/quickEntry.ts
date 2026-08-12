import type {
  Activity,
  Engagement,
  QuickAddPreferences,
  QuickAddSuggestion,
} from './types'

export const QUICK_ENTRY_NEUTRAL_COLOR = '#6F7B89'
export const QUICK_ENTRY_DEFAULT_DURATION_MINUTES = 30
export const QUICK_ENTRY_DRAG_ACTIVATION_PX = 4

const MINUTES_IN_DAY = 24 * 60
const HOUR_IN_MINUTES = 60
const QUICK_ENTRY_SNAP_MINUTES = 15
const QUICK_ENTRY_DURATION_STEP_MINUTES = 30
const QUICK_ENTRY_MAX_DURATION_MINUTES = 8 * HOUR_IN_MINUTES
const QUICK_ENTRY_DRAG_STEP_PX = 22

const EMPTY_QUICK_ADD_PREFERENCES: QuickAddPreferences = {
  engagementOrder: [],
  hiddenEngagementIds: [],
  activityOrder: {},
  hiddenActivityIds: [],
}

export interface QuickEntryActivityView {
  engagement: Engagement
  activity: Activity
  usageCount: number
  lastUsedAt: number | null
}

export interface QuickEntryActivityGroup {
  engagement: Engagement
  activities: QuickEntryActivityView[]
}

export interface QuickEntryDragState {
  engagementId: string
  activityId: string
  activityName: string
  pointerId: number
  originClientX: number
  currentClientX: number
  baseDurationMinutes: number
  durationMinutes: number
  isDragging: boolean
}

export interface QuickEntryModel {
  allActivities: QuickEntryActivityView[]
  orderedActivities: QuickEntryActivityView[]
  visibleActivities: QuickEntryActivityView[]
  groups: QuickEntryActivityGroup[]
  activityByKey: Map<string, QuickEntryActivityView>
}

interface BuildQuickEntryModelInput {
  engagements: Engagement[]
  preferences: QuickAddPreferences | null | undefined
  suggestions: QuickAddSuggestion[]
  suggestedKeys?: string[]
  search?: string
  includeHiddenShortcuts?: boolean
}

export function quickEntryActivityKey(engagementId: string, activityId: string): string {
  return `${engagementId}:${activityId}`
}

export function uniqueIds(values: string[]): string[] {
  const seen = new Set<string>()
  const next: string[] = []

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue
    }

    seen.add(value)
    next.push(value)
  }

  return next
}

export function sanitizeQuickAddPreferences(
  preferences: QuickAddPreferences | null | undefined,
  engagements: Engagement[],
): QuickAddPreferences {
  const source = preferences ?? EMPTY_QUICK_ADD_PREFERENCES
  const activeEngagementIds = new Set(
    engagements.filter((engagement) => engagement.isActive).map((engagement) => engagement.id),
  )
  const activeActivityIds = new Set<string>()
  const activityIdsByEngagement = new Map<string, Set<string>>()

  for (const engagement of engagements) {
    if (!engagement.isActive) {
      continue
    }

    const activeActivities = engagement.activities.filter((activity) => activity.isActive)
    const activeIds = new Set(activeActivities.map((activity) => activity.id))
    activityIdsByEngagement.set(engagement.id, activeIds)

    for (const activity of activeActivities) {
      activeActivityIds.add(activity.id)
    }
  }

  const activityOrder: Record<string, string[]> = {}
  for (const [engagementId, activityIds] of Object.entries(source.activityOrder ?? {})) {
    const activeIds = activityIdsByEngagement.get(engagementId)
    if (!activeIds) {
      continue
    }

    const orderedActivityIds = uniqueIds(activityIds).filter((activityId) => activeIds.has(activityId))
    if (orderedActivityIds.length > 0) {
      activityOrder[engagementId] = orderedActivityIds
    }
  }

  return {
    engagementOrder: uniqueIds(source.engagementOrder).filter((engagementId) =>
      activeEngagementIds.has(engagementId),
    ),
    hiddenEngagementIds: uniqueIds(source.hiddenEngagementIds).filter((engagementId) =>
      activeEngagementIds.has(engagementId),
    ),
    activityOrder,
    hiddenActivityIds: uniqueIds(source.hiddenActivityIds).filter((activityId) =>
      activeActivityIds.has(activityId),
    ),
  }
}

export function buildQuickAddSettingsDraft(
  preferences: QuickAddPreferences | null | undefined,
  engagements: Engagement[],
): QuickAddPreferences {
  const sanitized = sanitizeQuickAddPreferences(preferences, engagements)
  const engagementOrder = sanitized.engagementOrder.slice()
  const engagementSeen = new Set(engagementOrder)
  const activityOrder: Record<string, string[]> = { ...sanitized.activityOrder }

  for (const engagement of engagements) {
    if (!engagement.isActive) {
      continue
    }

    if (!engagementSeen.has(engagement.id)) {
      engagementOrder.push(engagement.id)
      engagementSeen.add(engagement.id)
    }

    const orderedActivityIds = activityOrder[engagement.id]?.slice() ?? []
    const activitySeen = new Set(orderedActivityIds)
    for (const activity of engagement.activities) {
      if (!activity.isActive || activitySeen.has(activity.id)) {
        continue
      }

      orderedActivityIds.push(activity.id)
      activitySeen.add(activity.id)
    }

    activityOrder[engagement.id] = orderedActivityIds
  }

  return {
    ...sanitized,
    engagementOrder,
    activityOrder,
  }
}

export function buildQuickEntryModel({
  engagements,
  preferences,
  suggestions,
  suggestedKeys,
  search = '',
  includeHiddenShortcuts = false,
}: BuildQuickEntryModelInput): QuickEntryModel {
  const quickAddPreferences = sanitizeQuickAddPreferences(preferences, engagements)
  const suggestionByKey = new Map<string, QuickAddSuggestion>()
  for (const suggestion of suggestions) {
    suggestionByKey.set(quickEntryActivityKey(suggestion.engagementId, suggestion.activityId), suggestion)
  }

  const allActivities: QuickEntryActivityView[] = []
  for (const engagement of engagements) {
    if (!engagement.isActive) {
      continue
    }

    for (const activity of engagement.activities) {
      if (!activity.isActive) {
        continue
      }

      const suggestion = suggestionByKey.get(quickEntryActivityKey(engagement.id, activity.id))
      allActivities.push({
        engagement,
        activity,
        usageCount: suggestion?.usageCount ?? 0,
        lastUsedAt: suggestion?.lastUsedAt ?? null,
      })
    }
  }

  const activityByKey = new Map<string, QuickEntryActivityView>()
  for (const item of allActivities) {
    activityByKey.set(quickEntryActivityKey(item.engagement.id, item.activity.id), item)
  }

  const suggestedActivities = buildSuggestedActivities(
    allActivities,
    activityByKey,
    suggestedKeys ?? suggestions.map((suggestion) =>
      quickEntryActivityKey(suggestion.engagementId, suggestion.activityId),
    ),
  )
  const orderedActivities = orderQuickEntryActivities(
    engagements,
    allActivities,
    suggestedActivities,
    quickAddPreferences,
    includeHiddenShortcuts,
  )
  const visibleActivities = filterQuickEntryActivities(orderedActivities, search)
  const groups = groupQuickEntryActivities(visibleActivities)

  return {
    allActivities,
    orderedActivities,
    visibleActivities,
    groups,
    activityByKey,
  }
}

export function formatEntityPrimaryLabel(
  name: string | null | undefined,
  code: string | null | undefined,
  fallback = 'Uncategorized',
): string {
  return normalizeDisplayText(name) ?? normalizeDisplayText(code) ?? fallback
}

export function formatEntityDisplayLabel(
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

export function formatQuickEntryDuration(minutes: number): string {
  if (minutes < HOUR_IN_MINUTES) {
    return `${minutes}m`
  }

  return formatTimelineHoursCompact(minutes)
}

export function quickEntryDurationProgress(minutes: number): number {
  const span = QUICK_ENTRY_MAX_DURATION_MINUTES - QUICK_ENTRY_DEFAULT_DURATION_MINUTES

  if (span <= 0) {
    return 0
  }

  return ((clampQuickEntryDuration(minutes) - QUICK_ENTRY_DEFAULT_DURATION_MINUTES) / span) * 100
}

export function quickEntryDurationFromDrag(
  originClientX: number,
  currentClientX: number,
  baseDurationMinutes = QUICK_ENTRY_DEFAULT_DURATION_MINUTES,
): number {
  const dragDistance = Math.max(0, currentClientX - originClientX)
  const durationSteps = Math.round(dragDistance / QUICK_ENTRY_DRAG_STEP_PX)
  return clampQuickEntryDuration(
    baseDurationMinutes
    + durationSteps * QUICK_ENTRY_DURATION_STEP_MINUTES,
  )
}

export function resolveQuickEntryCreateWindow(
  durationMinutes: number,
): { startMinute: number; endMinute: number } {
  const safeDuration = clampQuickEntryDuration(durationMinutes)
  const snappedStartMinute = currentRoundedTimelineStartMinute()
  const endMinute = Math.min(MINUTES_IN_DAY, snappedStartMinute + safeDuration)
  const startMinute = Math.max(0, endMinute - safeDuration)

  return { startMinute, endMinute }
}

function buildSuggestedActivities(
  allActivities: QuickEntryActivityView[],
  activityByKey: Map<string, QuickEntryActivityView>,
  suggestedKeys: string[],
): QuickEntryActivityView[] {
  const values: QuickEntryActivityView[] = []
  const seenKeys = new Set<string>()

  for (const key of suggestedKeys) {
    const item = activityByKey.get(key)
    if (!item || seenKeys.has(key)) {
      continue
    }

    values.push(item)
    seenKeys.add(key)
  }

  for (const item of allActivities) {
    const key = quickEntryActivityKey(item.engagement.id, item.activity.id)
    if (seenKeys.has(key)) {
      continue
    }

    values.push(item)
    seenKeys.add(key)
  }

  return values
}

function orderQuickEntryActivities(
  engagements: Engagement[],
  allActivities: QuickEntryActivityView[],
  suggestedActivities: QuickEntryActivityView[],
  quickAddPreferences: QuickAddPreferences,
  includeHiddenShortcuts: boolean,
): QuickEntryActivityView[] {
  const hiddenEngagementIds = new Set(quickAddPreferences.hiddenEngagementIds)
  const hiddenActivityIds = new Set(quickAddPreferences.hiddenActivityIds)
  const engagementOrderIndex = new Map(
    quickAddPreferences.engagementOrder.map((engagementId, index) => [engagementId, index]),
  )
  const hasCustomEngagementOrder = engagementOrderIndex.size > 0
  const suggestedActivityIndex = new Map(
    suggestedActivities.map((item, index) => [
      quickEntryActivityKey(item.engagement.id, item.activity.id),
      index,
    ]),
  )
  const engagementIndex = new Map(engagements.map((engagement, index) => [engagement.id, index]))
  const activityIndex = new Map<string, number>()

  for (const engagement of engagements) {
    engagement.activities.forEach((activity, index) => {
      activityIndex.set(activity.id, index)
    })
  }

  const groups = new Map<string, QuickEntryActivityGroup>()
  for (const item of allActivities) {
    if (
      !includeHiddenShortcuts
      && (
        hiddenEngagementIds.has(item.engagement.id)
        || hiddenActivityIds.has(item.activity.id)
      )
    ) {
      continue
    }

    const existing = groups.get(item.engagement.id)
    if (existing) {
      existing.activities.push(item)
      continue
    }

    groups.set(item.engagement.id, {
      engagement: item.engagement,
      activities: [item],
    })
  }

  const orderedGroups = [...groups.values()].sort((left, right) => {
    if (hasCustomEngagementOrder) {
      const leftCustomIndex = engagementOrderIndex.get(left.engagement.id)
      const rightCustomIndex = engagementOrderIndex.get(right.engagement.id)
      if (leftCustomIndex !== undefined || rightCustomIndex !== undefined) {
        return (
          leftCustomIndex ?? Number.MAX_SAFE_INTEGER
        ) - (
          rightCustomIndex ?? Number.MAX_SAFE_INTEGER
        )
      }
    }

    const leftSuggestionIndex = Math.min(
      ...left.activities.map((item) =>
        suggestedActivityIndex.get(quickEntryActivityKey(item.engagement.id, item.activity.id))
        ?? Number.MAX_SAFE_INTEGER,
      ),
    )
    const rightSuggestionIndex = Math.min(
      ...right.activities.map((item) =>
        suggestedActivityIndex.get(quickEntryActivityKey(item.engagement.id, item.activity.id))
        ?? Number.MAX_SAFE_INTEGER,
      ),
    )

    if (leftSuggestionIndex !== rightSuggestionIndex) {
      return leftSuggestionIndex - rightSuggestionIndex
    }

    return (
      engagementIndex.get(left.engagement.id) ?? Number.MAX_SAFE_INTEGER
    ) - (
      engagementIndex.get(right.engagement.id) ?? Number.MAX_SAFE_INTEGER
    )
  })

  return orderedGroups.flatMap((group) => {
    const customActivityOrder = quickAddPreferences.activityOrder[group.engagement.id] ?? []
    const customActivityOrderIndex = new Map(
      customActivityOrder.map((activityId, index) => [activityId, index]),
    )
    const hasCustomActivityOrder = customActivityOrderIndex.size > 0

    return group.activities.slice().sort((left, right) => {
      if (hasCustomActivityOrder) {
        const leftCustomIndex = customActivityOrderIndex.get(left.activity.id)
        const rightCustomIndex = customActivityOrderIndex.get(right.activity.id)
        if (leftCustomIndex !== undefined || rightCustomIndex !== undefined) {
          return (
            leftCustomIndex ?? Number.MAX_SAFE_INTEGER
          ) - (
            rightCustomIndex ?? Number.MAX_SAFE_INTEGER
          )
        }
      }

      const leftSuggestionIndex =
        suggestedActivityIndex.get(quickEntryActivityKey(left.engagement.id, left.activity.id))
        ?? Number.MAX_SAFE_INTEGER
      const rightSuggestionIndex =
        suggestedActivityIndex.get(quickEntryActivityKey(right.engagement.id, right.activity.id))
        ?? Number.MAX_SAFE_INTEGER

      if (leftSuggestionIndex !== rightSuggestionIndex) {
        return leftSuggestionIndex - rightSuggestionIndex
      }

      return (
        activityIndex.get(left.activity.id) ?? Number.MAX_SAFE_INTEGER
      ) - (
        activityIndex.get(right.activity.id) ?? Number.MAX_SAFE_INTEGER
      )
    })
  })
}

function filterQuickEntryActivities(
  orderedActivities: QuickEntryActivityView[],
  search: string,
): QuickEntryActivityView[] {
  const searchTerms = search
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  if (searchTerms.length === 0) {
    return orderedActivities
  }

  return orderedActivities.filter(({ engagement, activity }) => {
    const haystack = [
      engagement.code,
      engagement.name,
      activity.code,
      activity.name,
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()

    return searchTerms.every((term) => haystack.includes(term))
  })
}

function groupQuickEntryActivities(
  visibleActivities: QuickEntryActivityView[],
): QuickEntryActivityGroup[] {
  const groups: QuickEntryActivityGroup[] = []
  const groupByEngagementId = new Map<string, QuickEntryActivityGroup>()

  for (const item of visibleActivities) {
    let group = groupByEngagementId.get(item.engagement.id)
    if (!group) {
      group = {
        engagement: item.engagement,
        activities: [],
      }
      groupByEngagementId.set(item.engagement.id, group)
      groups.push(group)
    }

    group.activities.push(item)
  }

  return groups
}

function normalizeDisplayText(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function formatTimelineHoursCompact(minutes: number): string {
  const formattedHours = (minutes / HOUR_IN_MINUTES)
    .toFixed(2)
    .replace(/(?:\.0+|(\.\d*?)0+)$/, '$1')

  return `${formattedHours}h`
}

function snapMinute(value: number, increment: number): number {
  if (increment <= 0) {
    return value
  }

  return Math.round(value / increment) * increment
}

function clampQuickEntryDuration(durationMinutes: number): number {
  const rounded = snapMinute(durationMinutes, QUICK_ENTRY_DURATION_STEP_MINUTES)
  return Math.min(
    QUICK_ENTRY_MAX_DURATION_MINUTES,
    Math.max(QUICK_ENTRY_DEFAULT_DURATION_MINUTES, rounded),
  )
}

function currentRoundedTimelineStartMinute(): number {
  const now = new Date()
  const currentMinute = now.getHours() * HOUR_IN_MINUTES + now.getMinutes()
  return Math.min(
    MINUTES_IN_DAY,
    Math.max(
      0,
      snapMinute(currentMinute, QUICK_ENTRY_SNAP_MINUTES),
    ),
  )
}
