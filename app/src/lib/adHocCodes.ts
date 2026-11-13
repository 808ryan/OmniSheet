import type { AdHocCodes, EngagementType } from './types'

export function normalizeAdHocEngagementCode(value: string): string | null {
  const normalized = value.trim().toUpperCase()
  return /^[EIA]-[0-9]+$/.test(normalized) ? normalized : null
}

export function normalizeAdHocCodes(codes: AdHocCodes): AdHocCodes {
  return {
    engagementCode: codes.engagementCode.trim().toUpperCase(),
    activityCode: codes.activityCode?.trim() || null,
  }
}

export function inferAdHocEngagementType(code: string): EngagementType {
  return /^[IA]-/i.test(code.trim()) ? 'internal' : 'external'
}
