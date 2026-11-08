# OpenAI model options

The Settings model catalog was checked against the official OpenAI API documentation on 2026-11-07.

- Interpretation and Calendar Bulk Add offer GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Luna, and GPT-6 Astra.
- Each has Low, Medium, and High reasoning presets. Terra and Luna also offer No reasoning.
- Fresh-install defaults are Sol Low for interpretation and Terra Medium for calendar screenshots.
- Speech-to-Text uses GPT-Transcribe for completed recordings through `/v1/audio/transcriptions`.

Saved GPT-5.5 settings migrate to Sol with the same reasoning effort, except Instant becomes Low.
Saved GPT-5.4 Nano settings migrate to Luna, preserving effort (Instant becomes No reasoning).
Saved Whisper and GPT-4o Mini Transcribe selections migrate to GPT-Transcribe. Historical entry
metadata retains the model originally used. The old options are excluded from the Settings menus.

Presets are local settings IDs. Requests send the actual API model ID and a separate reasoning
parameter: `reasoning_effort` for interpretation's Chat Completions requests, or `reasoning.effort`
for calendar extraction's Responses requests. Existing output contracts are preserved. Model access
depends on the user's OpenAI API account; a ChatGPT subscription does not establish API model access.

Sources:
- [Model catalog](https://developers.openai.com/api/docs/models)
- [GPT-6 migration guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)
- [File transcription](https://developers.openai.com/api/docs/guides/speech-to-text)
