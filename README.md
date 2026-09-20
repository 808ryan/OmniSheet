# OmniSheet

OmniSheet is a desktop time tracker built with Tauri, React, TypeScript, and Rust. Capture work as it happens, review it on a timeline, and export a weekly timesheet.

## Features

- Manual time entries and a live timer.
- Daily and weekly timelines with drag-and-drop editing.
- Projects (called engagements), activity codes, and configurable reporting layouts.
- A quick-entry window available from the system tray or a keyboard shortcut.
- Optional text interpretation, voice transcription, and calendar-image extraction using your own OpenAI API key.
- Weekly Excel exports.

New installations include generic vacation and holiday categories. Add your own engagements and activities in the app; no client dataset is bundled.

## Run locally

Prerequisites: Node.js 22.12 or later, npm, stable Rust, and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system. Windows development requires the Microsoft C++ build tools and WebView2; macOS requires Xcode command-line tools.

```sh
cd app
npm ci
npm run tauri dev
```

Use the Tauri application for the full workflow. The standalone Vite frontend does not provide database or native desktop commands.

## Checks

```sh
cd app
npm run lint
npm test
npm run build
cd src-tauri
cargo fmt --check
cargo test --lib
```

Frontend regression tests use a simulated DOM and mocked native commands. They do not replace testing a packaged desktop app.

## Build

From `app/`, run `npm run tauri build`. Packaging and signing requirements vary by platform. See [macOS release instructions](docs/releasing-macos.md) for the signed macOS workflow. Release workflows create draft releases for review.

## Data and privacy

Time entries, project definitions, settings, and diagnostics are stored locally in the app's SQLite database. The database is not encrypted by the app. API keys are stored in the operating-system credential store, with a session-only fallback if storage is unavailable.

Manual entries and timers do not require an API key. AI features send the submitted text, audio, or image and relevant project context to OpenAI when you invoke them. Review that content before submitting confidential work. Diagnostics can include entry text; redact them before sharing a bug report.

## Repository layout

- `app/src/`: React interface and frontend logic.
- `app/src-tauri/src/`: native commands, SQLite storage, and API integration.
- `app/tests/`: frontend regression tests.
- `docs/`: release and project documentation.
- `scripts/`: development and release helpers.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [SECURITY.md](SECURITY.md) for reporting security concerns.

## License

[MIT](LICENSE).
