# Development

OmniSheet uses Tauri, React, TypeScript, and Rust. The desktop app provides SQLite storage and native commands; running only the Vite frontend won't provide the full application.

## Setup

Install Node.js 22.12 or later, npm, stable Rust, and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system. Windows development requires the Microsoft C++ build tools and WebView2; macOS requires Xcode command-line tools.

From the repository root:

```sh
cd app
npm ci
npm run tauri dev
```

## Checks

From the repository root:

```sh
node scripts/check-public-files.mjs
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

From `app/`, run `npm run tauri build`. Packaging and signing requirements vary by platform. See the [macOS release instructions](releasing-macos.md) for the signed macOS workflow. Release workflows create draft releases for review.

## Repository layout

- `app/src/`: React interface and frontend logic.
- `app/src-tauri/src/`: native commands, SQLite storage, and API integration.
- `app/tests/`: frontend regression tests.
- `docs/`: development and release documentation.
- `scripts/`: development and release helpers.
