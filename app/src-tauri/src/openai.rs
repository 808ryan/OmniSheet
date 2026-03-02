use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::models::{CodeContext, LlmResponse};

const OPENAI_MODEL: &str = "gpt-5-nano";
const OPENAI_CHAT_COMPLETIONS_URL: &str = "https://api.openai.com/v1/chat/completions";

fn build_system_prompt() -> &'static str {
    r#"
You are OmniSheet, a timesheet interpretation assistant.
Return strict JSON with this shape:
{
  "entries": [
    {
      "engagementCode": string | null,
      "activityCode": string | null,
      "date": "YYYY-MM-DD",
      "startTime": "HH:MM" | null,
      "endTime": "HH:MM" | null,
      "durationMinutes": number | null,
      "description": string,
      "confidence": number
    }
  ]
}

Temporal inference rules (priority order):
1) Explicit clock times in the message:
   - Use those times directly (normalized to HH:MM 24-hour format).
2) Relative duration cues (for example: "for the past hour", "last 45 minutes", "for 2 hours"):
   - Infer endTime from clientLocalTime.
   - Infer startTime as endTime - durationMinutes.
   - Set durationMinutes consistently.
3) Relative anchor cues (for example: "since lunch", "since 1pm"):
   - Infer a reasonable start from the anchor.
   - Infer endTime from clientLocalTime.
   - Set durationMinutes consistently.
4) Only when no usable temporal intent exists:
   - Set startTime/endTime/durationMinutes to null.

Additional rules:
- Infer date from capture context and inferred time window.
- Never default missing times to 00:00.
- If uncertain, set lower confidence.
- Use describeWhenToUse as the primary categorization signal for engagements and activities.
- Use tags/key words as secondary hints; exact keyword overlap is not required.
- If you identify an engagementCode and that engagement has activities in the provided context, choose the best available activityCode from that engagement.
- Use activityCode = null only as a last resort when the selected engagement has no activities or no reasonable mapping can be inferred.
- If no engagement match exists, set engagementCode/activityCode to null.
- Duration and times must be internally consistent.
- Confidence must be in range 0.0 to 1.0.
- Never include text outside JSON.

Examples:
- Message: "for the past hour i've been in meetings for RR ITACs"
  clientLocalTime: "21:48"
  Expected temporal intent: startTime "20:48", endTime "21:48", durationMinutes 60.
- Message: "worked on controls testing"
  Expected temporal intent: startTime null, endTime null, durationMinutes null.
"#
}

pub async fn interpret_message(
    client: &reqwest::Client,
    api_key: &str,
    raw_text: &str,
    client_timestamp_iso: &str,
    client_local_date: &str,
    client_local_time: &str,
    client_utc_offset_minutes: i64,
    timezone: &str,
    code_context: &CodeContext,
) -> AppResult<LlmResponse> {
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

    let response = client
        .post(OPENAI_CHAT_COMPLETIONS_URL)
        .bearer_auth(api_key)
        .json(&json!({
          "model": OPENAI_MODEL,
          "response_format": { "type": "json_object" },
          "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt.to_string() }
          ]
        }))
        .send()
        .await?;

    let status = response.status();
    let response_json: Value = response.json().await?;

    if !status.is_success() {
        return Err(AppError::Service(format!(
            "OpenAI API error ({status}): {response_json}"
        )));
    }

    let content = response_json
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Service("OpenAI response missing message content".to_string()))?;

    let parsed = serde_json::from_str::<LlmResponse>(content).map_err(|error| {
        AppError::Service(format!(
            "Failed to parse structured LLM response: {error}. Raw content: {content}"
        ))
    })?;

    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::build_system_prompt;

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
    fn prompt_makes_activity_null_a_last_resort_when_engagement_is_known() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("choose the best available activityCode"));
        assert!(prompt.contains("Use activityCode = null only as a last resort"));
        assert!(prompt.contains("If no engagement match exists"));
    }

    #[test]
    fn prompt_prioritizes_description_over_tags_for_categorization() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("Use describeWhenToUse as the primary categorization signal"));
        assert!(prompt.contains("Use tags/key words as secondary hints"));
    }
}
