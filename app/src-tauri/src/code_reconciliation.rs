use crate::models::{CodeContext, ContextActivity, ContextEngagement, NormalizedEntry};

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum ReconciliationReason {
    AlreadyValid,
    EngagementSlotContainedActivityCode,
    DerivedEngagementFromActivityCode,
    ClearedInvalidActivityForEngagement,
    AmbiguousActivityCodeAcrossEngagements,
    UnknownCodesUnresolved,
}

impl ReconciliationReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ReconciliationReason::AlreadyValid => "already_valid",
            ReconciliationReason::EngagementSlotContainedActivityCode => {
                "engagement_slot_contained_activity_code"
            }
            ReconciliationReason::DerivedEngagementFromActivityCode => {
                "derived_engagement_from_activity_code"
            }
            ReconciliationReason::ClearedInvalidActivityForEngagement => {
                "cleared_invalid_activity_for_engagement"
            }
            ReconciliationReason::AmbiguousActivityCodeAcrossEngagements => {
                "ambiguous_activity_code_across_engagements"
            }
            ReconciliationReason::UnknownCodesUnresolved => "unknown_codes_unresolved",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CodeReconciliationDecision {
    pub applied: bool,
    pub reason: ReconciliationReason,
    pub original_engagement_code: Option<String>,
    pub original_activity_code: Option<String>,
    pub reconciled_engagement_code: Option<String>,
    pub reconciled_activity_code: Option<String>,
    pub ambiguous_candidate_count: usize,
}

#[derive(Debug, Clone)]
struct ActivityOwner {
    engagement_code: String,
    activity_code: String,
}

pub fn reconcile_codes(
    entry: &mut NormalizedEntry,
    code_context: &CodeContext,
) -> CodeReconciliationDecision {
    let original_engagement_code = normalize_code(entry.engagement_code.clone());
    let original_activity_code = normalize_code(entry.activity_code.clone());

    let mut reconciled_engagement_code = original_engagement_code.clone();
    let mut reconciled_activity_code = original_activity_code.clone();
    let mut reason = ReconciliationReason::UnknownCodesUnresolved;
    let mut ambiguous_candidate_count = 0usize;

    match reconciled_engagement_code.as_deref() {
        Some(engagement_code) => {
            if let Some(engagement) = find_engagement(code_context, engagement_code) {
                reconciled_engagement_code = Some(engagement.code.clone());
                reason = ReconciliationReason::AlreadyValid;

                if let Some(activity_code) = reconciled_activity_code.as_deref() {
                    if let Some(activity) = find_activity(engagement, activity_code) {
                        reconciled_activity_code = Some(activity.code.clone());
                    } else {
                        reconciled_activity_code = None;
                        reason = ReconciliationReason::ClearedInvalidActivityForEngagement;
                    }
                }
            } else {
                let owners_for_engagement_code =
                    activity_owners_for_code(code_context, engagement_code);
                if owners_for_engagement_code.len() == 1 {
                    let owner = &owners_for_engagement_code[0];
                    reconciled_engagement_code = Some(owner.engagement_code.clone());
                    reconciled_activity_code = Some(owner.activity_code.clone());
                    reason = ReconciliationReason::EngagementSlotContainedActivityCode;
                } else if let Some(activity_code) = reconciled_activity_code.as_deref() {
                    let owners_for_activity_code =
                        activity_owners_for_code(code_context, activity_code);
                    if owners_for_activity_code.len() == 1 {
                        let owner = &owners_for_activity_code[0];
                        reconciled_engagement_code = Some(owner.engagement_code.clone());
                        reconciled_activity_code = Some(owner.activity_code.clone());
                        reason = ReconciliationReason::DerivedEngagementFromActivityCode;
                    } else if owners_for_engagement_code.len() > 1
                        || owners_for_activity_code.len() > 1
                    {
                        reason = ReconciliationReason::AmbiguousActivityCodeAcrossEngagements;
                        ambiguous_candidate_count = owners_for_engagement_code
                            .len()
                            .max(owners_for_activity_code.len());
                    }
                } else if owners_for_engagement_code.len() > 1 {
                    reason = ReconciliationReason::AmbiguousActivityCodeAcrossEngagements;
                    ambiguous_candidate_count = owners_for_engagement_code.len();
                }
            }
        }
        None => {
            if let Some(activity_code) = reconciled_activity_code.as_deref() {
                let owners = activity_owners_for_code(code_context, activity_code);
                if owners.len() == 1 {
                    let owner = &owners[0];
                    reconciled_engagement_code = Some(owner.engagement_code.clone());
                    reconciled_activity_code = Some(owner.activity_code.clone());
                    reason = ReconciliationReason::DerivedEngagementFromActivityCode;
                } else if owners.len() > 1 {
                    reason = ReconciliationReason::AmbiguousActivityCodeAcrossEngagements;
                    ambiguous_candidate_count = owners.len();
                }
            }
        }
    }

    let applied = original_engagement_code != reconciled_engagement_code
        || original_activity_code != reconciled_activity_code;

    entry.engagement_code = reconciled_engagement_code.clone();
    entry.activity_code = reconciled_activity_code.clone();

    CodeReconciliationDecision {
        applied,
        reason,
        original_engagement_code,
        original_activity_code,
        reconciled_engagement_code,
        reconciled_activity_code,
        ambiguous_candidate_count,
    }
}

fn normalize_code(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn find_engagement<'a>(
    code_context: &'a CodeContext,
    engagement_code: &str,
) -> Option<&'a ContextEngagement> {
    code_context
        .engagements
        .iter()
        .find(|candidate| candidate.code.eq_ignore_ascii_case(engagement_code))
}

fn find_activity<'a>(
    engagement: &'a ContextEngagement,
    activity_code: &str,
) -> Option<&'a ContextActivity> {
    engagement
        .activities
        .iter()
        .find(|candidate| candidate.code.eq_ignore_ascii_case(activity_code))
}

fn activity_owners_for_code(code_context: &CodeContext, activity_code: &str) -> Vec<ActivityOwner> {
    let mut owners = Vec::new();

    for engagement in &code_context.engagements {
        for activity in &engagement.activities {
            if activity.code.eq_ignore_ascii_case(activity_code) {
                owners.push(ActivityOwner {
                    engagement_code: engagement.code.clone(),
                    activity_code: activity.code.clone(),
                });
            }
        }
    }

    owners
}

#[cfg(test)]
mod tests {
    use crate::models::{CodeContext, ContextActivity, ContextEngagement, NormalizedEntry};

    use super::{reconcile_codes, ReconciliationReason};

    fn build_context() -> CodeContext {
        CodeContext {
            engagements: vec![
                ContextEngagement {
                    code: "E-1".to_string(),
                    name: "Client One".to_string(),
                    tags: vec![],
                    describe_when_to_use: None,
                    activities: vec![
                        ContextActivity {
                            code: "A-1".to_string(),
                            name: "Testing".to_string(),
                            tags: vec![],
                            describe_when_to_use: None,
                        },
                        ContextActivity {
                            code: "SHARED".to_string(),
                            name: "Shared Activity".to_string(),
                            tags: vec![],
                            describe_when_to_use: None,
                        },
                    ],
                },
                ContextEngagement {
                    code: "E-2".to_string(),
                    name: "Client Two".to_string(),
                    tags: vec![],
                    describe_when_to_use: None,
                    activities: vec![
                        ContextActivity {
                            code: "B-1".to_string(),
                            name: "Meetings".to_string(),
                            tags: vec![],
                            describe_when_to_use: None,
                        },
                        ContextActivity {
                            code: "SHARED".to_string(),
                            name: "Shared Activity".to_string(),
                            tags: vec![],
                            describe_when_to_use: None,
                        },
                    ],
                },
            ],
        }
    }

    fn build_entry(engagement_code: Option<&str>, activity_code: Option<&str>) -> NormalizedEntry {
        NormalizedEntry {
            date: "2026-03-10".to_string(),
            start_minute: 60,
            end_minute: 90,
            duration_minutes: 30,
            description: "Example".to_string(),
            user_submission_text: "Example".to_string(),
            confidence: 0.9,
            engagement_code: engagement_code.map(|value| value.to_string()),
            activity_code: activity_code.map(|value| value.to_string()),
        }
    }

    #[test]
    fn keeps_valid_pair_unchanged() {
        let context = build_context();
        let mut entry = build_entry(Some("E-1"), Some("A-1"));
        let decision = reconcile_codes(&mut entry, &context);

        assert_eq!(entry.engagement_code.as_deref(), Some("E-1"));
        assert_eq!(entry.activity_code.as_deref(), Some("A-1"));
        assert!(!decision.applied);
        assert_eq!(decision.reason, ReconciliationReason::AlreadyValid);
    }

    #[test]
    fn repairs_when_engagement_slot_contains_activity_code() {
        let context = build_context();
        let mut entry = build_entry(Some("A-1"), Some("B-1"));
        let decision = reconcile_codes(&mut entry, &context);

        assert_eq!(entry.engagement_code.as_deref(), Some("E-1"));
        assert_eq!(entry.activity_code.as_deref(), Some("A-1"));
        assert!(decision.applied);
        assert_eq!(
            decision.reason,
            ReconciliationReason::EngagementSlotContainedActivityCode
        );
    }

    #[test]
    fn derives_engagement_from_activity_when_engagement_is_invalid() {
        let context = build_context();
        let mut entry = build_entry(Some("UNKNOWN"), Some("B-1"));
        let decision = reconcile_codes(&mut entry, &context);

        assert_eq!(entry.engagement_code.as_deref(), Some("E-2"));
        assert_eq!(entry.activity_code.as_deref(), Some("B-1"));
        assert!(decision.applied);
        assert_eq!(
            decision.reason,
            ReconciliationReason::DerivedEngagementFromActivityCode
        );
    }

    #[test]
    fn clears_invalid_activity_for_valid_engagement() {
        let context = build_context();
        let mut entry = build_entry(Some("E-1"), Some("B-1"));
        let decision = reconcile_codes(&mut entry, &context);

        assert_eq!(entry.engagement_code.as_deref(), Some("E-1"));
        assert!(entry.activity_code.is_none());
        assert!(decision.applied);
        assert_eq!(
            decision.reason,
            ReconciliationReason::ClearedInvalidActivityForEngagement
        );
    }

    #[test]
    fn keeps_unresolved_when_activity_code_is_ambiguous() {
        let context = build_context();
        let mut entry = build_entry(None, Some("SHARED"));
        let decision = reconcile_codes(&mut entry, &context);

        assert!(entry.engagement_code.is_none());
        assert_eq!(entry.activity_code.as_deref(), Some("SHARED"));
        assert!(!decision.applied);
        assert_eq!(
            decision.reason,
            ReconciliationReason::AmbiguousActivityCodeAcrossEngagements
        );
        assert_eq!(decision.ambiguous_candidate_count, 2);
    }

    #[test]
    fn canonicalizes_case_and_whitespace() {
        let context = build_context();
        let mut entry = build_entry(Some(" e-1 "), Some(" a-1 "));
        let decision = reconcile_codes(&mut entry, &context);

        assert_eq!(entry.engagement_code.as_deref(), Some("E-1"));
        assert_eq!(entry.activity_code.as_deref(), Some("A-1"));
        assert!(decision.applied);
        assert_eq!(decision.reason, ReconciliationReason::AlreadyValid);
    }
}
