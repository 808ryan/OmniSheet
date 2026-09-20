use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};
use crate::models::{
    CalendarVisionResponse, CodeContext, LlmResponse, OpenAiModelId, TranscriptionModelId,
};

const OPENAI_CHAT_COMPLETIONS_URL: &str = "https://api.openai.com/v1/chat/completions";
const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
const OPENAI_AUDIO_TRANSCRIPTIONS_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
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
      "sequenceRelation": "startsAfterPrevious" | "independent" | null,
      "durationSource": "explicit" | "defaulted" | "inferred" | null,
      "activityReason": string | null,
      "alternativeActivities": [
        {
          "activityRef": string,
          "reason": string
        }
      ] | null,
      "confidence": number
    }
  ],
  "gapFillRequests": [
    {
      "date": "YYYY-MM-DD" | null,
      "startTime": "HH:MM" | null,
      "endTime": "HH:MM" | null,
      "activities": [
        {
          "engagementRef": string | null,
          "activityRef": string | null,
          "label": string,
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
  ],
  "timeOffRequests": [
    {
      "kind": "vacation" | "holiday",
      "startDate": "YYYY-MM-DD",
      "endDate": "YYYY-MM-DD",
      "description": string | null,
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
4) Bare duration worklog cues without explicit clock times (for example: "15 minutes to non-sap", "30 minutes on exampleco review", "spent 15 minutes on non-sap"):
   - Treat these as already completed or recent work by default; do not interpret them as start now and end later.
   - When the phrasing indicates recent/current work, infer endTime from clientLocalTime.
   - Infer startTime as endTime - durationMinutes.
   - If the phrasing is clearly future/planned (for example: "tomorrow 15 minutes on non-sap", "going to spend 15 minutes on non-sap"), do not anchor to clientLocalTime without a stronger time cue.
5) Relative anchor cues (for example: "since lunch", "since 1pm"):
   - Infer a reasonable start from the anchor.
   - Infer endTime from clientLocalTime.
   - Set durationMinutes consistently.
6) Only when no usable temporal intent exists:
   - Set startTime/endTime/durationMinutes to null.

Additional rules:
- Identify all distinct work events in the message.
- Return one entry per distinct work event.
- Preserve the order that events appear in the message.
- Do not split a single event into multiple entries unless intent or time window clearly changes.
- For sequential connectors such as "then", "after that", "afterwards", "next", or "following that", set sequenceRelation = "startsAfterPrevious" on the later entry unless the later entry has its own explicit clock time.
- Do not invent time gaps after "then" or "after that"; the later entry should start when the prior entry ends unless an explicit later time is stated.
- Set durationSource = "explicit" only when the user stated the duration for that entry; set "defaulted" for a missing duration default, and "inferred" for a model-estimated duration.
- Infer date from capture context and inferred time window.
- Never default missing times to 00:00.
- If uncertain, set lower confidence.
- Use the strongest evidence across both engagement-level and activity-level context.
- Use describeWhenToUse as the primary categorization signal, especially when it is more specific than names or tags.
- Use names as the primary visible categorization cue.
- If a user-provided code appears in the context, treat it as a secondary hint only.
- Use tags/key words as secondary hints; exact keyword overlap is not required.
- engagementRef must be selected from engagementActivityContext.engagements[].engagementRef only.
- activityRef must be selected from the chosen engagement's activities[].activityRef only.
- Never invent or modify refs.
- A strong match to an activity is sufficient to infer that activity's parent engagementRef.
- If an activity under engagement X is the best match, return that activityRef together with engagement X's engagementRef.
- Do not require the parent engagement's own describeWhenToUse, name, or tags to independently match when the child activity is a clear best match.
- If you identify an engagementRef and that engagement has activities in the provided context, choose the best available activityRef from that engagement.
- Prefer the most specific workstream activity over generic meeting/admin activities when the message contains workstream-specific terms such as non-sap, rr itacs, firefighter, sap itgcs, or exampleco review work.
- Use activityRef = null only as a last resort when the selected engagement has no activities or no reasonable mapping can be inferred.
- If no specific activity or engagement can be reasonably inferred, set engagementRef/activityRef to null.
- If activityRef is not null, include activityReason that cites the strongest evidence from message text plus provided context.
- If activityRef is not null, include alternativeActivities with up to 3 rejected activityRef values from the same engagement and concise rejection reasons.
- If activityRef is null, set activityReason and alternativeActivities to null.
- Duration and times must be internally consistent.
- Confidence must be in range 0.0 to 1.0.
- Never include text outside JSON.

Gap fill rules:
- Use gapFillRequests, not regular entries, when the user asks to fill open calendar/workday time or says they generally worked on multiple listed things within a range.
- For gap fill requests, return entries = [] and one gapFillRequests item with activities in the same order as the user's list.
- The app will calculate existing free gaps and exact durations; do not invent precise per-activity start/end blocks in entries for gap-fill intent.
- If the user gives no date for a gap fill request, set date = selectedDate when provided; otherwise use clientLocalDate.
- If the user gives no fill window, set startTime "09:00" and endTime "18:00".
- For workday shorthand ranges in gap-fill wording, interpret "3 to 6" as "15:00" to "18:00" and "9 to 2" as "09:00" to "14:00" unless the wording clearly indicates otherwise.
- Match each listed activity independently against the engagement/activity context. Include engagementRef/activityRef when reasonably known, and keep the user's visible words in label/description.

Time off rules:
- Use timeOffRequests, not regular entries, when the user says they are OOO, out of office, taking PTO, on vacation, or observing a holiday.
- For OOO, out of office, PTO, and vacation, set kind = "vacation" unless the message also explicitly says holiday or public holiday.
- For holiday or public holiday wording, set kind = "holiday", including phrases such as "OOO next Monday for holiday".
- Do not choose engagementRef or activityRef for timeOffRequests; the app will map vacation and holiday requests to standard codes.
- Set startDate and endDate as inclusive dates. For a single day, set both fields to the same date.
- "next week" means the next Monday through Friday workweek after the clientLocalDate or selectedDate.
- Business-day expansion is handled by the app; return one timeOffRequests item for a range instead of one entry per day.

Examples:
- Message: "for the past hour i've been in meetings for RR ITACs"
  clientLocalTime: "21:48"
  Expected temporal intent: startTime "20:48", endTime "21:48", durationMinutes 60.
- Message: "in the morning i spent 30 minutes on an ExampleCo related meeting"
  clientLocalTime: "22:13"
  Expected temporal intent: startTime "09:30", endTime "10:00", durationMinutes 30.
- Message: "going to spend 30 minutes at 6pm for exampleco"
  Expected temporal intent: startTime "18:00", endTime "18:30", durationMinutes 30.
- Message: "finished a 30-minute meeting at 6pm"
  Expected temporal intent: startTime "17:30", endTime "18:00", durationMinutes 30.
- Message: "15 minutes to non-sap FDT-DB-02 with Nick"
  clientLocalTime: "18:18"
  Expected temporal intent: when the phrasing indicates recent/current work, infer startTime "18:03", endTime "18:18", durationMinutes 15.
- Message: "30 minutes to SAP ITGCs"
  clientLocalTime: "14:40"
  Expected temporal intent: startTime "14:10", endTime "14:40", durationMinutes 30. Do not return startTime "14:40" and endTime "15:10".
- Message: "tomorrow 15 minutes on non-sap"
  Expected temporal intent: startTime null, endTime null, durationMinutes 15.
- Message: "About to spend 30 minutes with the team on Example ITGCs. After that, an hour on Non-SAP ITGCs."
  clientLocalTime: "15:27"
  Expected temporal intent: first entry startTime "15:27", endTime "15:57", durationMinutes 30, durationSource "explicit"; second entry startTime "15:57", endTime "16:57", durationMinutes 60, sequenceRelation "startsAfterPrevious", durationSource "explicit".
- Message: "At 1pm today, I worked on Example ITGCs. Then I worked on ExampleCo report 1."
  Expected temporal intent: first entry startTime "13:00", endTime "13:30", durationMinutes 30; second entry sequenceRelation "startsAfterPrevious", startTime "13:30", endTime "14:00", durationMinutes 30, durationSource "defaulted".
- Message: "At 1pm I worked on Example ITGCs. Then at 3pm I worked on ExampleCo report 1."
  Expected temporal intent: preserve the explicit 15:00 second start; do not force the second entry to start immediately after the first.
- Message: "uploading prior year workpapers for non-sap, 30 minutes"
  Expected categorization intent: if the context contains a child activity whose name or describeWhenToUse clearly matches "non-sap", return that activityRef together with its parent engagementRef even if the parent engagement description is generic audit wording.
  Expected temporal intent: startTime null, endTime null, durationMinutes 30.
- Message: "team sync and status meeting, 30 minutes"
  Expected categorization intent: use a generic meeting/admin activity only when there is no more specific workstream activity signal in the message.
- Message: "worked on controls testing"
  Expected temporal intent: startTime null, endTime null, durationMinutes null.
- Message: "Fill out my calendar using Example ITGCs, Non-SAP ITGCs, and ExampleCo report 1"
  selectedDate: "2026-04-15"
  Expected gap-fill intent: entries []; gapFillRequests[0] date "2026-04-15", startTime "09:00", endTime "18:00", activities in the listed order.
- Message: "Worked on Example ITGCs, Non-SAP, and ExampleCo between 3 and 6"
  Expected gap-fill intent: entries []; gapFillRequests[0] startTime "15:00", endTime "18:00", activities in the listed order.
- Message: "From 9 to 2, worked on Example ITGCs, Non-SAP, ExampleCo"
  Expected gap-fill intent: entries []; gapFillRequests[0] startTime "09:00", endTime "14:00", activities in the listed order.
- Message: "I'm OOO next week"
  Expected time-off intent: entries []; timeOffRequests[0] kind "vacation", startDate as next Monday, endDate as next Friday.
- Message: "I'm on vacation next week"
  Expected time-off intent: entries []; timeOffRequests[0] kind "vacation", startDate as next Monday, endDate as next Friday.
- Message: "I'm OOO on Friday"
  Expected time-off intent: entries []; timeOffRequests[0] kind "vacation", startDate and endDate as that Friday.
- Message: "I'm OOO next Monday for holiday"
  Expected time-off intent: entries []; timeOffRequests[0] kind "holiday", startDate and endDate as the coming Monday.
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
    selected_date: Option<&str>,
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
      "selectedDate": selected_date,
      "engagementActivityContext": code_context,
    });

    let mut request_body = json!({
      "model": model.api_name(),
      "response_format": { "type": "json_object" },
      "messages": [
        { "role": "system", "content": system_prompt },
        { "role": "user", "content": user_prompt.to_string() }
      ]
    });

    if let Some(effort) = model.reasoning_effort() {
        request_body["reasoning_effort"] = json!(effort);
    }

    request_body
}

fn build_calendar_extraction_system_prompt() -> &'static str {
    r#"
You are OmniSheet's calendar screenshot extraction assistant.
Return strict JSON matching the provided schema.

Task:
- Read a screenshot from any calendar application.
- Identify every visible timed calendar event block, including short 15-minute and 30-minute blocks, partially visible/cropped blocks, and thin blocks near the edge of the screenshot.
- Ignore decorative UI, toolbar text, current weather, account names, navigation, empty grid space, and recurring/meeting icons.
- Include all-day events only as events with isAllDay=true; do not invent times for all-day rows.
- For timed events, infer the visible date and start/end time from the grid position, visible day headers, and the block's top/bottom edges relative to time labels and horizontal grid lines.
- Derive durationMinutes from the visual block height against the calendar time grid. Do not assume one-hour duration when the block height indicates 15, 30, 45, 90, or another visible duration.
- If start/end text inside the block conflicts with the visual height, return the best visual startTime/endTime/durationMinutes and explain the conflict in timeEvidence.
- Use timeEvidence to briefly describe how the time was read, such as "top aligns with 16:00, block height spans one 30-minute grid interval."
- Preserve the event title text as closely as possible. Put extra visible details such as meeting URLs or attendees in details.
- Use null for unknown date/time fields rather than guessing.
- If a screenshot includes a date range such as "May 4 - May 8, 2026", use it to resolve every day column to YYYY-MM-DD.
- If only weekday/day-of-month are visible, provide weekday and dayOfMonth even when date is null.
- Classify each event using the supplied engagementActivityContext when there is a reasonable work match.
- engagementRef must come from engagementActivityContext.engagements[].engagementRef only.
- activityRef must come from the chosen engagement's activities[].activityRef only.
- If no specific work match is reasonable, set engagementRef/activityRef to null.
- Confidence is 0.0 to 1.0 and should be lower for cropped, truncated, ambiguous, or visually crowded blocks.

Never include text outside JSON.
"#
}

fn calendar_event_schema() -> Value {
    let nullable_string = json!({
        "anyOf": [
            { "type": "string" },
            { "type": "null" }
        ]
    });
    let nullable_integer = json!({
        "anyOf": [
            { "type": "integer" },
            { "type": "null" }
        ]
    });
    let nullable_number = json!({
        "anyOf": [
            { "type": "number" },
            { "type": "null" }
        ]
    });

    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "events": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "title": { "type": "string" },
                        "details": nullable_string,
                        "date": nullable_string,
                        "weekday": nullable_string,
                        "dayOfMonth": nullable_integer,
                        "startTime": nullable_string,
                        "endTime": nullable_string,
                        "durationMinutes": nullable_integer,
                        "timeEvidence": nullable_string,
                        "isAllDay": { "type": "boolean" },
                        "engagementRef": nullable_string,
                        "activityRef": nullable_string,
                        "confidence": nullable_number,
                        "visualNotes": nullable_string
                    },
                    "required": [
                        "title",
                        "details",
                        "date",
                        "weekday",
                        "dayOfMonth",
                        "startTime",
                        "endTime",
                        "durationMinutes",
                        "timeEvidence",
                        "isAllDay",
                        "engagementRef",
                        "activityRef",
                        "confidence",
                        "visualNotes"
                    ]
                }
            }
        },
        "required": ["events"]
    })
}

fn build_calendar_extraction_request_body(
    model: OpenAiModelId,
    image_base64: &str,
    mime_type: &str,
    client_timestamp_iso: &str,
    client_local_date: &str,
    client_local_time: &str,
    client_utc_offset_minutes: i64,
    timezone: &str,
    selected_date: &str,
    code_context: &CodeContext,
) -> Value {
    let image_url = format!("data:{};base64,{}", mime_type.trim(), image_base64.trim());
    let user_prompt = json!({
        "clientTimestampIso": client_timestamp_iso,
        "clientLocalDate": client_local_date,
        "clientLocalTime": client_local_time,
        "clientUtcOffsetMinutes": client_utc_offset_minutes,
        "timezone": timezone,
        "selectedOmniSheetDate": selected_date,
        "engagementActivityContext": code_context,
    });

    let mut request_body = json!({
        "model": model.api_name(),
        "input": [
            {
                "role": "system",
                "content": [
                    {
                        "type": "input_text",
                        "text": build_calendar_extraction_system_prompt()
                    }
                ]
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": user_prompt.to_string()
                    },
                    {
                        "type": "input_image",
                        "image_url": image_url,
                        "detail": "high"
                    }
                ]
            }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "calendar_events",
                "strict": true,
                "schema": calendar_event_schema()
            }
        }
    });

    if let Some(effort) = model.reasoning_effort() {
        request_body["reasoning"] = json!({ "effort": effort });
    }

    request_body
}

fn audio_filename_for_mime_type(mime_type: &str) -> &'static str {
    let normalized = mime_type.trim().to_ascii_lowercase();

    if normalized.contains("webm") {
        return "capture.webm";
    }

    if normalized.contains("wav") {
        return "capture.wav";
    }

    if normalized.contains("mpeg") || normalized.contains("mp3") {
        return "capture.mp3";
    }

    if normalized.contains("ogg") {
        return "capture.ogg";
    }

    if normalized.contains("mp4") || normalized.contains("m4a") {
        return "capture.m4a";
    }

    "capture.webm"
}

fn build_transcription_form(
    model: TranscriptionModelId,
    audio_bytes: &[u8],
    mime_type: &str,
) -> AppResult<Form> {
    let file_part = Part::bytes(audio_bytes.to_vec())
        .file_name(audio_filename_for_mime_type(mime_type).to_string())
        .mime_str(mime_type)
        .map_err(|error| AppError::InvalidInput(format!("unsupported audio mime type: {error}")))?;

    Ok(Form::new()
        .text("model", model.api_name().to_string())
        .text("response_format", "json".to_string())
        .part("file", file_part))
}

fn extract_responses_output_text(response_json: &Value) -> Option<String> {
    if let Some(value) = response_json.get("output_text").and_then(Value::as_str) {
        return Some(value.to_string());
    }

    let output = response_json.get("output")?.as_array()?;
    let mut parts = Vec::<String>::new();

    for item in output {
        let Some(content) = item.get("content").and_then(Value::as_array) else {
            continue;
        };

        for content_item in content {
            if content_item
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|value| value == "output_text")
            {
                if let Some(text) = content_item.get("text").and_then(Value::as_str) {
                    parts.push(text.to_string());
                }
            }
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(""))
    }
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
    selected_date: Option<&str>,
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
        selected_date,
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
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
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
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
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
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
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

#[allow(clippy::too_many_arguments)]
pub async fn extract_calendar_events(
    client: &reqwest::Client,
    api_key: &str,
    model: OpenAiModelId,
    image_base64: &str,
    mime_type: &str,
    client_timestamp_iso: &str,
    client_local_date: &str,
    client_local_time: &str,
    client_utc_offset_minutes: i64,
    timezone: &str,
    selected_date: &str,
    code_context: &CodeContext,
    attempt_telemetry: &mut Vec<LlmAttemptTelemetry>,
) -> AppResult<CalendarVisionResponse> {
    let request_body = build_calendar_extraction_request_body(
        model,
        image_base64,
        mime_type,
        client_timestamp_iso,
        client_local_date,
        client_local_time,
        client_utc_offset_minutes,
        timezone,
        selected_date,
        code_context,
    );

    for attempt in 0..OPENAI_MAX_ATTEMPTS {
        let attempt_number = attempt + 1;
        let attempt_started_at = Instant::now();

        let response = client
            .post(OPENAI_RESPONSES_URL)
            .bearer_auth(api_key)
            .json(&request_body)
            .send()
            .await;

        let response = match response {
            Ok(value) => value,
            Err(error) => {
                let retryable =
                    attempt_number < OPENAI_MAX_ATTEMPTS && is_retryable_transport_error(&error);
                let delay_ms =
                    retryable.then_some(OPENAI_RETRY_BASE_DELAY_MS * attempt_number as u64);

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
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
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
                let delay_ms =
                    retryable.then_some(OPENAI_RETRY_BASE_DELAY_MS * attempt_number as u64);

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
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    continue;
                }

                return Err(AppError::Network(error));
            }
        };

        if !status.is_success() {
            let retryable =
                attempt_number < OPENAI_MAX_ATTEMPTS && is_retryable_status(status.as_u16());
            let delay_ms = retryable.then_some(OPENAI_RETRY_BASE_DELAY_MS * attempt_number as u64);

            attempt_telemetry.push(LlmAttemptTelemetry {
                attempt: attempt_number,
                max_attempts: OPENAI_MAX_ATTEMPTS,
                duration_ms: attempt_duration_ms(attempt_started_at),
                outcome: "http_error",
                http_status: Some(status.as_u16()),
                retryable,
                retry_delay_ms: delay_ms,
                error_class: None,
                error_message: Some(format!("OpenAI Responses API error ({status})")),
            });

            if let Some(delay_ms) = delay_ms {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                continue;
            }

            return Err(AppError::Service(format!(
                "OpenAI Responses API error ({status}): {response_text}"
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
                "Failed to parse OpenAI Responses JSON: {error}. Raw response: {response_text}"
            ))
        })?;

        let content = extract_responses_output_text(&response_json).ok_or_else(|| {
            attempt_telemetry.push(LlmAttemptTelemetry {
                attempt: attempt_number,
                max_attempts: OPENAI_MAX_ATTEMPTS,
                duration_ms: attempt_duration_ms(attempt_started_at),
                outcome: "parse_error",
                http_status: Some(status.as_u16()),
                retryable: false,
                retry_delay_ms: None,
                error_class: None,
                error_message: Some("OpenAI Responses output missing text".to_string()),
            });
            AppError::Service("OpenAI Responses output missing text".to_string())
        })?;

        let parsed = serde_json::from_str::<CalendarVisionResponse>(&content).map_err(|error| {
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
                "Failed to parse calendar extraction response: {error}. Raw content: {content}"
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
        "OpenAI calendar extraction request exhausted retry attempts".to_string(),
    ))
}

pub async fn transcribe_audio(
    client: &reqwest::Client,
    api_key: &str,
    model: TranscriptionModelId,
    audio_bytes: &[u8],
    mime_type: &str,
    attempt_telemetry: &mut Vec<LlmAttemptTelemetry>,
) -> AppResult<String> {
    for attempt in 0..OPENAI_MAX_ATTEMPTS {
        let attempt_number = attempt + 1;
        let attempt_started_at = Instant::now();
        let form = build_transcription_form(model, audio_bytes, mime_type)?;

        let response = client
            .post(OPENAI_AUDIO_TRANSCRIPTIONS_URL)
            .bearer_auth(api_key)
            .multipart(form)
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
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
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
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
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
                error_message: Some(format!("OpenAI transcription API error ({status})")),
            });

            if let Some(delay_ms) = delay_ms {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                continue;
            }

            return Err(AppError::Service(format!(
                "OpenAI transcription API error ({status}): {response_text}"
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
                "Failed to parse OpenAI transcription response JSON: {error}. Raw response: {response_text}"
            ))
        })?;

        let transcript = response_json
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
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
                    error_message: Some("OpenAI transcription response missing text".to_string()),
                });
                AppError::Service("OpenAI transcription response missing text".to_string())
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

        return Ok(transcript.to_string());
    }

    Err(AppError::Service(
        "OpenAI transcription request exhausted retry attempts".to_string(),
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

    use super::{
        audio_filename_for_mime_type, build_calendar_extraction_request_body,
        build_calendar_extraction_system_prompt, build_request_body, build_system_prompt,
        calendar_event_schema, is_retryable_status,
    };
    use crate::models::{CodeContext, OpenAiModelId};

    #[test]
    fn prompt_includes_relative_duration_inference_rules() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("Relative duration cues"));
        assert!(prompt.contains("Infer endTime from clientLocalTime"));
        assert!(prompt.contains("for the past hour"));
        assert!(prompt.contains("Bare duration worklog cues without explicit clock times"));
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
        assert!(prompt
            .contains("\"in the morning i spent 30 minutes on an ExampleCo related meeting\""));
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
    fn prompt_includes_bare_duration_worklog_guidance() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("Bare duration worklog cues"));
        assert!(prompt.contains("\"30 minutes to SAP ITGCs\""));
        assert!(prompt.contains("do not interpret them as start now and end later"));
        assert!(prompt.contains("Do not return startTime \"14:40\" and endTime \"15:10\""));
    }

    #[test]
    fn prompt_makes_activity_null_a_last_resort_when_engagement_is_known() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("choose the best available activityRef"));
        assert!(prompt.contains("Use activityRef = null only as a last resort"));
        assert!(prompt.contains("If no specific activity or engagement can be reasonably inferred"));
    }

    #[test]
    fn prompt_prioritizes_description_over_tags_for_categorization() {
        let prompt = build_system_prompt();
        assert!(prompt.contains(
            "Use the strongest evidence across both engagement-level and activity-level context"
        ));
        assert!(prompt.contains("Use describeWhenToUse as the primary categorization signal"));
        assert!(prompt.contains("Use names as the primary visible categorization cue"));
        assert!(prompt.contains("Use tags/key words as secondary hints"));
    }

    #[test]
    fn prompt_allows_activity_to_imply_parent_engagement() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("A strong match to an activity is sufficient to infer that activity's parent engagementRef"));
        assert!(
            prompt.contains("return that activityRef together with engagement X's engagementRef")
        );
        assert!(prompt.contains("Do not require the parent engagement's own describeWhenToUse"));
    }

    #[test]
    fn prompt_includes_non_sap_and_generic_meeting_disambiguation_examples() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("\"15 minutes to non-sap FDT-DB-02 with Nick\""));
        assert!(prompt.contains(
            "when the phrasing indicates recent/current work, infer startTime \"18:03\", endTime \"18:18\", durationMinutes 15."
        ));
        assert!(prompt.contains("\"30 minutes to SAP ITGCs\""));
        assert!(prompt.contains("do not interpret them as start now and end later"));
        assert!(prompt.contains("Do not return startTime \"14:40\" and endTime \"15:10\""));
        assert!(prompt.contains("\"tomorrow 15 minutes on non-sap\""));
        assert!(prompt.contains("\"uploading prior year workpapers for non-sap, 30 minutes\""));
        assert!(prompt.contains(
            "child activity whose name or describeWhenToUse clearly matches \"non-sap\""
        ));
        assert!(prompt.contains("\"team sync and status meeting, 30 minutes\""));
        assert!(prompt.contains("generic meeting/admin activity only when there is no more specific workstream activity signal"));
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
        assert!(prompt.contains("\"sequenceRelation\""));
        assert!(prompt.contains("\"durationSource\""));
        assert!(prompt.contains("Do not invent time gaps after \"then\" or \"after that\""));
        assert!(prompt.contains("About to spend 30 minutes with the team on Example ITGCs"));
        assert!(prompt.contains("Then at 3pm"));
    }

    #[test]
    fn prompt_requests_gap_fill_contract_and_defaults() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("\"gapFillRequests\""));
        assert!(prompt.contains("Use gapFillRequests, not regular entries"));
        assert!(prompt.contains("selectedDate"));
        assert!(prompt.contains("startTime \"09:00\" and endTime \"18:00\""));
        assert!(prompt.contains(
            "\"Fill out my calendar using Example ITGCs, Non-SAP ITGCs, and ExampleCo report 1\""
        ));
        assert!(
            prompt.contains("\"Worked on Example ITGCs, Non-SAP, and ExampleCo between 3 and 6\"")
        );
        assert!(prompt.contains("\"From 9 to 2, worked on Example ITGCs, Non-SAP, ExampleCo\""));
    }

    #[test]
    fn prompt_requests_time_off_contract_and_examples() {
        let prompt = build_system_prompt();
        assert!(prompt.contains("\"timeOffRequests\""));
        assert!(prompt.contains("Use timeOffRequests, not regular entries"));
        assert!(prompt.contains("OOO, out of office, PTO, and vacation"));
        assert!(prompt.contains("holiday or public holiday"));
        assert!(prompt.contains("\"I'm OOO next week\""));
        assert!(prompt.contains("\"I'm on vacation next week\""));
        assert!(prompt.contains("\"I'm OOO on Friday\""));
        assert!(prompt.contains("\"I'm OOO next Monday for holiday\""));
    }

    #[test]
    fn calendar_prompt_includes_short_block_visual_height_guidance() {
        let prompt = build_calendar_extraction_system_prompt();
        assert!(prompt.contains("15-minute and 30-minute blocks"));
        assert!(prompt.contains("block's top/bottom edges"));
        assert!(prompt.contains("visual block height"));
        assert!(prompt.contains("Do not assume one-hour duration"));
        assert!(prompt.contains("timeEvidence"));
    }

    #[test]
    fn calendar_schema_requires_duration_and_time_evidence_fields() {
        let schema = calendar_event_schema();
        let event_schema = schema
            .get("properties")
            .and_then(|value| value.get("events"))
            .and_then(|value| value.get("items"))
            .expect("events item schema should exist");
        let properties = event_schema
            .get("properties")
            .and_then(Value::as_object)
            .expect("event properties should exist");
        assert!(properties.contains_key("durationMinutes"));
        assert!(properties.contains_key("timeEvidence"));

        let required = event_schema
            .get("required")
            .and_then(Value::as_array)
            .expect("event required fields should exist");
        assert!(required
            .iter()
            .any(|value| value.as_str() == Some("durationMinutes")));
        assert!(required
            .iter()
            .any(|value| value.as_str() == Some("timeEvidence")));
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
            OpenAiModelId::Gpt55Instant,
            "worked on controls testing",
            "2026-03-15T18:00:00Z",
            "2026-03-15",
            "11:00",
            -420,
            "America/Los_Angeles",
            Some("2026-03-16"),
            &CodeContext {
                engagements: vec![],
            },
        );

        assert_eq!(
            request_body
                .get("model")
                .and_then(Value::as_str)
                .expect("model should be serialized"),
            "gpt-5.5"
        );
        assert_eq!(
            request_body
                .get("reasoning_effort")
                .and_then(Value::as_str)
                .expect("reasoning effort should be serialized"),
            "none"
        );
        let user_prompt = request_body
            .get("messages")
            .and_then(Value::as_array)
            .and_then(|messages| messages.get(1))
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .expect("user prompt should be serialized");
        assert!(user_prompt.contains("\"selectedDate\":\"2026-03-16\""));
    }

    #[test]
    fn request_body_sets_configured_reasoning_effort() {
        let request_body = build_request_body(
            OpenAiModelId::Gpt54NanoHigh,
            "worked on controls testing",
            "2026-03-15T18:00:00Z",
            "2026-03-15",
            "11:00",
            -420,
            "America/Los_Angeles",
            Some("2026-03-16"),
            &CodeContext {
                engagements: vec![],
            },
        );

        assert_eq!(
            request_body
                .get("model")
                .and_then(Value::as_str)
                .expect("model should be serialized"),
            "gpt-5.4-nano"
        );
        assert_eq!(
            request_body
                .get("reasoning_effort")
                .and_then(Value::as_str)
                .expect("reasoning effort should be serialized"),
            "high"
        );
    }

    #[test]
    fn calendar_request_body_sets_configured_reasoning_effort() {
        let request_body = build_calendar_extraction_request_body(
            OpenAiModelId::Gpt54NanoLow,
            "abc123",
            "image/png",
            "2026-03-15T18:00:00Z",
            "2026-03-15",
            "11:00",
            -420,
            "America/Los_Angeles",
            "2026-03-16",
            &CodeContext {
                engagements: vec![],
            },
        );

        assert_eq!(
            request_body
                .get("model")
                .and_then(Value::as_str)
                .expect("model should be serialized"),
            "gpt-5.4-nano"
        );
        assert_eq!(
            request_body
                .get("reasoning")
                .and_then(|reasoning| reasoning.get("effort"))
                .and_then(Value::as_str)
                .expect("reasoning effort should be serialized"),
            "low"
        );
    }

    #[test]
    fn audio_filename_defaults_match_common_recording_mime_types() {
        assert_eq!(
            audio_filename_for_mime_type("audio/webm;codecs=opus"),
            "capture.webm"
        );
        assert_eq!(audio_filename_for_mime_type("audio/wav"), "capture.wav");
        assert_eq!(audio_filename_for_mime_type("audio/mp4"), "capture.m4a");
        assert_eq!(audio_filename_for_mime_type("audio/ogg"), "capture.ogg");
        assert_eq!(
            audio_filename_for_mime_type("application/octet-stream"),
            "capture.webm"
        );
    }
}
