use serde_json::{json, Value};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};
use crate::models::{CodeContext, LlmResponse, OpenAiModelId};

const OPENAI_CHAT_COMPLETIONS_URL: &str = "https://api.openai.com/v1/chat/completions";
const OPENAI_MAX_ATTEMPTS: usize = 3;
const OPENAI_RETRY_BASE_DELAY_MS: u64 = 700;

#[derive(Debug, Clone)]
pub struct LlmAttemptTelemetry {
    pub attempt: usize,
    pub max_attempts: usize,
    pub duration_ms: i64,
    pub outcome: &'static str,
    pub http_status: Option<u16>,
    pub retryable: bool,
    pub retry_delay_ms: Option<u64>,
    pub error_class: Option<&'static str>,
    pub error_message: Option<String>,
}

fn build_system_prompt() -> &'static str {
    r#"
You are OmniSheet, a timesheet interpretation assistant.
Return strict JSON with this shape:
{
  "entries": [
    {
      "engagementRef": string | null,
      "activityRef": string | null,
      "date": "YYYY-MM-DD",
      "startTime": "HH:MM" | null,
      "endTime": "HH:MM" | null,
      "durationMinutes": number | null,
      "description": string,
      "activityReason": string | null,
      "alternativeActivities": [
        {
          "activityRef": string,
          "reason": string
        }
      ] | null,
      "confidence": number
    }
  ]
}

Temporal inference rules (priority order):
1) Explicit clock times in the message:
   - Use those times directly (normalized to HH:MM 24-hour format).
   - If the message includes exactly one explicit clock time plus duration and the phrasing is neutral or start-anchored (for example: "at 6pm", "starting at 6pm", "spend 30 minutes at 6pm"), treat that explicit time as startTime and compute endTime = startTime + durationMinutes.
   - Only treat an explicit time as endTime when there is clear end-anchor wording (for example: "until 6pm", "ending at 6pm", "finished at 6pm", "done by 6pm").
2) Contextual day-part cues without explicit clock times (for example: "in the morning", "this afternoon", "tonight"):
   - Use a reasonable time window that matches the cue in the user's local day.
   - For "morning", default to a window between 08:00 and 12:00 local time.
   - If day-part and duration cues both exist, keep the entry inside the day-part window and use durationMinutes only to size the block (do not anchor to clientLocalTime).
3) Relative duration cues (for example: "for the past hour", "last 45 minutes", "for 2 hours"):
   - Infer endTime from clientLocalTime.
   - Infer startTime as endTime - durationMinutes.
   - Set durationMinutes consistently.
4) Relative anchor cues (for example: "since lunch", "since 1pm"):
   - Infer a reasonable start from the anchor.
   - Infer endTime from clientLocalTime.
   - Set durationMinutes consistently.
5) Only when no usable temporal intent exists:
   - Set startTime/endTime/durationMinutes to null.

Additional rules:
- Identify all distinct work events in the message.
- Return one entry per distinct work event.
- Preserve the order that events appear in the message.
- Do not split a single event into multiple entries unless intent or time window clearly changes.
- Infer date from capture context and inferred time window.
- Never default missing times to 00:00.
- If uncertain, set lower confidence.
- Use describeWhenToUse as the primary categorization signal for engagements and activities.
- Use names as the primary visible categorization cue.
- If a user-provided code appears in the context, treat it as a secondary hint only.
- Use tags/key words as secondary hints; exact keyword overlap is not required.
- engagementRef must be selected from engagementActivityContext.engagements[].engagementRef only.
- activityRef must be selected from the chosen engagement's activities[].activityRef only.
- Never invent or modify refs.
- If you identify an engagementRef and that engagement has activities in the provided context, choose the best available activityRef from that engagement.
- Use activityRef = null only as a last resort when the selected engagement has no activities or no reasonable mapping can be inferred.
- If no engagement match exists, set engagementRef/activityRef to null.
- If activityRef is not null, include activityReason that cites the strongest evidence from message text plus provided context.
- If activityRef is not null, include alternativeActivities with up to 3 rejected activityRef values from the same engagement and concise rejection reasons.
- If activityRef is null, set activityReason and alternativeActivities to null.
- Duration and times must be internally consistent.
- Confidence must be in range 0.0 to 1.0.
- Never include text outside JSON.

Examples:
- Message: "for the past hour i've been in meetings for RR ITACs"
  clientLocalTime: "21:48"
  Expected temporal intent: startTime "20:48", endTime "21:48", durationMinutes 60.
- Message: "in the morning i spent 30 minutes on a ExampleCo related meeting"
  clientLocalTime: "22:13"
  Expected temporal intent: startTime "09:30", endTime "10:00", durationMinutes 30.
- Message: "going to spend 30 minutes at 6pm for exampleco"
  Expected temporal intent: startTime "18:00", endTime "18:30", durationMinutes 30.
- Message: "finished a 30-minute meeting at 6pm"
  Expected temporal intent: startTime "17:30", endTime "18:00", durationMinutes 30.
- Message: "worked on controls testing"
  Expected temporal intent: startTime null, endTime null, durationMinutes null.
"#
}

fn build_request_body(
    model: OpenAiModelId,
    raw_text: &str,
    client_timestamp_iso: &str,
    client_local_date: &str,
    client_local_time: &str,
    client_utc_offset_minutes: i64,
    timezone: &str,
    code_context: &CodeContext,
) -> Value {
    let system_prompt = build_system_prompt();

    let user_prompt = json!({
      "message": raw_text,
      "clientTimestampIso": client_timestamp_iso,
      "clientLocalDate": client_local_date,
      "clientLocalTime": client_local_time,
      "clientUtcOffsetMinutes": client_utc_offset_minutes,
      "timezone": timezone,
      "engagementActivityContext": code_context,
    });

    json!({
      "model": model.api_name(),
      "response_format": { "type": "json_object" },
      "messages": [
        { "role": "system", "content": system_prompt },
        { "role": "user", "content": user_prompt.to_string() }
      ]
    })
}

pub async fn interpret_message(
    client: &reqwest::Client,
    api_key: &str,
    model: OpenAiModelId,
    raw_text: &str,
    client_timestamp_iso: &str,
    client_local_date: &str,
    client_local_time: &str,
    client_utc_offset_minutes: i64,
    timezone: &str,
    code_context: &CodeContext,
    attempt_telemetry: &mut Vec<LlmAttemptTelemetry>,
) -> AppResult<LlmResponse> {
    let request_body = build_request_body(
        model,
        raw_text,
        client_timestamp_iso,
        client_local_date,
        client_local_time,
        client_utc_offset_minutes,
        timezone,
        code_context,
    );

    for attempt in 0..OPENAI_MAX_ATTEMPTS {
        let attempt_number = attempt + 1;
        let attempt_started_at = Instant::now();

        let response = client
            .post(OPENAI_CHAT_COMPLETIONS_URL)
            .bearer_auth(api_key)
            .json(&request_body)
            .send()
            .await;

        let response = match response {
            Ok(value) => value,
            Err(error) => {
                let retryable =
                    attempt_number < OPENAI_MAX_ATTEMPTS && is_retryable_transport_error(&error);
                let delay_ms = if retryable {
                    Some(OPENAI_RETRY_BASE_DELAY_MS * attempt_number as u64)
                } else {
                    None
                };

                attempt_telemetry.push(LlmAttemptTelemetry {
                    attempt: attempt_number,
                    max_attempts: OPENAI_MAX_ATTEMPTS,
                    duration_ms: attempt_duration_ms(attempt_started_at),
                    outcome: "transport_error",
                    http_status: None,
                    retryable,
                    retry_delay_ms: delay_ms,
                    error_class: Some(transport_error_class(&error)),
                    error_message: Some(error.to_string()),
                });

                if let Some(delay_ms) = delay_ms {
                    thread::sleep(Duration::from_millis(delay_ms));
                    continue;
                }
                return Err(AppError::Network(error));
            }
        };

        let status = response.status();
        let response_text = match response.text().await {
            Ok(value) => value,
            Err(error) => {
                let retryable =
                    attempt_number < OPENAI_MAX_ATTEMPTS && is_retryable_transport_error(&error);
                let delay_ms = if retryable {
                    Some(OPENAI_RETRY_BASE_DELAY_MS * attempt_number as u64)
                } else {
                    None
                };

                attempt_telemetry.push(LlmAttemptTelemetry {
                    attempt: attempt_number,
                    max_attempts: OPENAI_MAX_ATTEMPTS,
                    duration_ms: attempt_duration_ms(attempt_started_at),
                    outcome: "transport_error",
                    http_status: Some(status.as_u16()),
                    retryable,
                    retry_delay_ms: delay_ms,
                    error_class: Some(transport_error_class(&error)),
                    error_message: Some(error.to_string()),
                });

                if let Some(delay_ms) = delay_ms {
                    thread::sleep(Duration::from_millis(delay_ms));
                    continue;
                }

                return Err(AppError::Network(error));
            }
        };

        if !status.is_success() {
            let retryable =
                attempt_number < OPENAI_MAX_ATTEMPTS && is_retryable_status(status.as_u16());
            let delay_ms = if retryable {
                Some(OPENAI_RETRY_BASE_DELAY_MS * attempt_number as u64)
            } else {
                None
            };

            attempt_telemetry.push(LlmAttemptTelemetry {
                attempt: attempt_number,
                max_attempts: OPENAI_MAX_ATTEMPTS,
                duration_ms: attempt_duration_ms(attempt_started_at),
                outcome: "http_error",
                http_status: Some(status.as_u16()),
                retryable,
                retry_delay_ms: delay_ms,
                error_class: None,
                error_message: Some(format!("OpenAI API error ({status})")),
            });

            if let Some(delay_ms) = delay_ms {
                thread::sleep(Duration::from_millis(delay_ms));
                continue;
            }

            return Err(AppError::Service(format!(
                "OpenAI API error ({status}): {response_text}"
            )));
        }

        let response_json: Value = serde_json::from_str(&response_text).map_err(|error| {
            attempt_telemetry.push(LlmAttemptTelemetry {
                attempt: attempt_number,
                max_attempts: OPENAI_MAX_ATTEMPTS,
                duration_ms: attempt_duration_ms(attempt_started_at),
                outcome: "parse_error",
                http_status: Some(status.as_u16()),
                retryable: false,
                retry_delay_ms: None,
                error_class: None,
                error_message: Some(error.to_string()),
            });

            AppError::Service(format!(
                "Failed to parse OpenAI response JSON: {error}. Raw response: {response_text}"
            ))
        })?;

        let content = response_json
            .get("choices")
            .and_then(|choices| choices.get(0))
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                attempt_telemetry.push(LlmAttemptTelemetry {
                    attempt: attempt_number,
                    max_attempts: OPENAI_MAX_ATTEMPTS,
                    duration_ms: attempt_duration_ms(attempt_started_at),
                    outcome: "parse_error",
                    http_status: Some(status.as_u16()),
                    retryable: false,
                    retry_delay_ms: None,
                    error_class: None,
                    error_message: Some("OpenAI response missing message content".to_string()),
                });
                AppError::Service("OpenAI response missing message content".to_string())
            })?;

        let parsed = serde_json::from_str::<LlmResponse>(content).map_err(|error| {
            attempt_telemetry.push(LlmAttemptTelemetry {
                attempt: attempt_number,
                max_attempts: OPENAI_MAX_ATTEMPTS,
                duration_ms: attempt_duration_ms(attempt_started_at),
                outcome: "parse_error",
                http_status: Some(status.as_u16()),
                retryable: false,
                retry_delay_ms: None,
                error_class: None,
                error_message: Some(error.to_string()),
            });

            AppError::Service(format!(
                "Failed to parse structured LLM response: {error}. Raw content: {content}"
            ))
        })?;

        attempt_telemetry.push(LlmAttemptTelemetry {
            attempt: attempt_number,
            max_attempts: OPENAI_MAX_ATTEMPTS,
            duration_ms: attempt_duration_ms(attempt_started_at),
            outcome: "success",
            http_status: Some(status.as_u16()),
            retryable: false,
            retry_delay_ms: None,
            error_class: None,
            error_message: None,
        });

        return Ok(parsed);
    }

    Err(AppError::Service(
        "OpenAI request exhausted retry attempts".to_string(),
    ))
}

fn attempt_duration_ms(started_at: Instant) -> i64 {
    started_at.elapsed().as_millis() as i64
}

fn is_retryable_transport_error(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request()
}

fn transport_error_class(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_request() {
        "request"
    } else {
        "other"
    }
}

fn is_retryable_status(status_code: u16) -> bool {
    status_code == 408 || status_code == 429 || (500..=599).contains(&status_code)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::{build_request_body, build_system_prompt, is_retryable_status};
    use crate::models::{CodeContext, OpenAiModelId};

    #[test]
    fn prompt_includes_relative_duration_inference_rules() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("Relative duration cues"));
        assert!(prompt.contains("Infer endTime from clientLocalTime"));
        assert!(prompt.contains("for the past hour"));
    }

    #[test]
    fn prompt_limits_null_temporal_fields_to_no_intent_cases() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("Only when no usable temporal intent exists"));
        assert!(prompt.contains("Set startTime/endTime/durationMinutes to null"));
        assert!(prompt.contains("Never default missing times to 00:00"));
    }

    #[test]
    fn prompt_includes_day_part_guidance_with_morning_defaults() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("Contextual day-part cues without explicit clock times"));
        assert!(prompt.contains("default to a window between 08:00 and 12:00 local time"));
        assert!(prompt.contains("do not anchor to clientLocalTime"));
    }

    #[test]
    fn prompt_includes_morning_duration_example() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("\"in the morning i spent 30 minutes on a ExampleCo related meeting\""));
        assert!(prompt.contains(
            "Expected temporal intent: startTime \"09:30\", endTime \"10:00\", durationMinutes 30."
        ));
    }

    #[test]
    fn prompt_disambiguates_single_time_duration_anchor_defaults() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("message includes exactly one explicit clock time plus duration"));
        assert!(prompt.contains("treat that explicit time as startTime"));
        assert!(prompt.contains("clear end-anchor wording"));
        assert!(prompt.contains("\"going to spend 30 minutes at 6pm for exampleco\""));
        assert!(prompt.contains(
            "Expected temporal intent: startTime \"18:00\", endTime \"18:30\", durationMinutes 30."
        ));
        assert!(prompt.contains("\"finished a 30-minute meeting at 6pm\""));
        assert!(prompt.contains(
            "Expected temporal intent: startTime \"17:30\", endTime \"18:00\", durationMinutes 30."
        ));
    }

    #[test]
    fn prompt_makes_activity_null_a_last_resort_when_engagement_is_known() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("choose the best available activityRef"));
        assert!(prompt.contains("Use activityRef = null only as a last resort"));
        assert!(prompt.contains("If no engagement match exists"));
    }

    #[test]
    fn prompt_prioritizes_description_over_tags_for_categorization() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("Use describeWhenToUse as the primary categorization signal"));
        assert!(prompt.contains("Use names as the primary visible categorization cue"));
        assert!(prompt.contains("Use tags/key words as secondary hints"));
    }

    #[test]
    fn prompt_requests_activity_explainability_fields() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("\"activityReason\": string | null"));
        assert!(prompt.contains("\"alternativeActivities\""));
        assert!(prompt.contains("include activityReason"));
        assert!(prompt.contains("rejected activityRef values"));
    }

    #[test]
    fn prompt_requests_multi_event_splitting_in_order() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("distinct work events"));
        assert!(prompt.contains("one entry per distinct work event"));
        assert!(prompt.contains("Preserve the order"));
    }

    #[test]
    fn retryable_status_includes_backoff_eligible_codes() {
        assert!(is_retryable_status(408));
        assert!(is_retryable_status(429));
        assert!(is_retryable_status(500));
        assert!(!is_retryable_status(400));
    }

    #[test]
    fn request_body_uses_resolved_model_id() {
        let request_body = build_request_body(
            OpenAiModelId::Gpt41Nano,
            "worked on controls testing",
            "2026-03-15T18:00:00Z",
            "2026-03-15",
            "11:00",
            -420,
            "America/Los_Angeles",
            &CodeContext {
                engagements: vec![],
            },
        );

        assert_eq!(
            request_body
                .get("model")
                .and_then(Value::as_str)
                .expect("model should be serialized"),
            "gpt-4.1-nano"
        );
    }
}
