use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::models::{CodeContext, LlmResponse};

const OPENAI_MODEL: &str = "gpt-4o-mini";
const OPENAI_CHAT_COMPLETIONS_URL: &str = "https://api.openai.com/v1/chat/completions";

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
    let system_prompt = r#"
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

Rules:
- Infer start/end from natural language and provided capture context.
- If the message does NOT contain a concrete clock time, set startTime/endTime/durationMinutes to null.
- Never default missing times to 00:00.
- If uncertain, set lower confidence.
- If no match exists, set engagementCode/activityCode to null.
- Duration and times must be internally consistent.
- Confidence must be in range 0.0 to 1.0.
- Never include text outside JSON.
"#;

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
          "temperature": 0,
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
