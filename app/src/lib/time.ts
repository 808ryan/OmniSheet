export function formatDate(value: Date): string {
  const year = value.getFullYear()
  const month = `${value.getMonth() + 1}`.padStart(2, '0')
  const day = `${value.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function parseDate(value: string): Date {
  const [year, month, day] = value.split('-').map((token) => Number(token))
  return new Date(year, (month ?? 1) - 1, day ?? 1)
}

export function shiftDate(value: string, dayDelta: number): string {
  const date = parseDate(value)
  date.setDate(date.getDate() + dayDelta)
  return formatDate(date)
}

export function minuteToTimeInput(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60)
  const minute = totalMinutes % 60
  return `${`${hour}`.padStart(2, '0')}:${`${minute}`.padStart(2, '0')}`
}

export function timeInputToMinute(value: string): number {
  const [hourToken, minuteToken] = value.split(':')
  const hours = Number(hourToken)
  const minutes = Number(minuteToken)

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return 0
  }

  return hours * 60 + minutes
}

export function minuteToLabel(totalMinutes: number): string {
  const normalizedMinutes = ((Math.floor(totalMinutes) % 1440) + 1440) % 1440
  if (normalizedMinutes === 12 * 60) {
    return 'Noon'
  }

  const hours24 = Math.floor(normalizedMinutes / 60)
  const minutes = normalizedMinutes % 60
  const suffix = hours24 >= 12 ? 'PM' : 'AM'
  const hours12 = hours24 % 12 || 12
  if (minutes === 0) {
    return `${hours12} ${suffix}`
  }

  return `${hours12}:${`${minutes}`.padStart(2, '0')} ${suffix}`
}

export function durationToHourLabel(durationMinutes: number): string {
  return `${(durationMinutes / 60).toFixed(1)}h`
}

export function parseTagInput(value: string): string[] {
  return value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

export function joinTags(tags: string[]): string {
  return tags.join(', ')
}
