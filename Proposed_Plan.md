# OmniSheet - Proposed Architecture & Implementation Plan

## 1. Goals & Objectives

### The Problem
Time tracking is a manual, error-prone bottleneck. Currently, time is vaguely tracked in a spreadsheet throughout the week, then manually categorized by engagement code and activity code at week's end for timesheet submission. This process is:
- **Time-consuming**: Reconstructing a week's worth of activities from memory
- **Inaccurate**: Forgetting activities, misremembering durations, incorrect code assignments
- **Tedious**: Manually matching work to the correct engagement code + activity code combinations

### The Solution: OmniSheet
A desktop application that lets users **speak or type** what they're working on throughout the day. The app automatically:
1. **Captures** the message with timestamp metadata
2. **Transcribes** voice input to text (if voice)
3. **Interprets** the unstructured message using AI - extracting time blocks, matching to engagement/activity codes, and calculating durations
4. The application should have two "views" that the user can look into:
a) Daily timeline, which will get updated with the blocks of activity that is added by the application, each block has transcribed text for that event, along with program suggested engagement code and activity code. 
b) Timesheet view, which contains:
A table that has columns for Monday (2/16), Tuesday (2/17) Wedensday (2/18), Thursday (2/19), Friday (2/20). 1 row which will contain engagement code and activity code. 
For any new engagements or any new activity code combinations used throughout the week, a row is added, and all the hours from each engagement code + activity code combo is listed out in this summarized weekly timesheet view. 

### Success Criteria
- User can type or speak a message like "just finished a 30 minute SAP ITGC meeting with the Apple team" and have it appear as a correctly coded, correctly timed block on their daily timeline within seconds
- At week's end, the user has a complete weekly timesheet summary (engagement code + activity code rows, Mon-Fri columns with hours) ready for submission
- The system correctly matches >90% of messages to the right engagement/activity codes using user-defined tags
- Total infrastructure cost under $5/month for a small team

### Target Platforms
- **Phase 1**: Windows + macOS desktop application
- **Phase 2+**: iOS (iPhone), potentially web

### Target Users
- The developer (solo use initially)
- A small team (~5 people) in a professional services / audit environment
- Users who track time across multiple engagements/projects with specific billing codes

---

## 2. Core Features

### 2.1 Engagement & Activity Code Onboarding
Users configure their engagement codes, activity codes, and matching tags:
```
Engagement Code: E-1234567
Engagement Name: Apple FY26
  └── Activity Code: 461
      Activity Name: SAP ITGCs
      Tags: ["SAP ITGC", "SAP", "SAP meetings", "SAP ITGC meetings"]
  └── Activity Code: 462
      Activity Name: Non-SAP ITGCs
      Tags: ["non-SAP ITGC", "non-SAP", "controls testing"]
  └── Activity Code: 470
      Activity Name: Planning
      Tags: ["audit planning", "planning meetings"]
```

Tags are user-defined aliases that help the AI match unstructured messages to the correct codes. For example, if a user says "SAP meeting," the tag "SAP meetings" on Activity 461 helps the AI correctly categorize it.

### 2.2 Message Input (Text)
A text input where the user types unstructured messages about their work:
- "Just finished a 30 minute SAP ITGC meeting with the Apple team"
- "Spent two hours this morning on the Johnson audit, then switched to Smith tax return after lunch"
- "Been working on non-SAP controls testing since 1pm"

The app captures the message text and the current timestamp as metadata.

### 2.3 Message Input (Voice)
A voice recording feature accessible from:
- A button in the app UI
- The macOS menu bar / Windows system tray (click to start/stop recording)

Voice input is transcribed to text, then processed identically to text input.

### 2.4 AI-Powered Interpretation
The AI receives the user's message + timestamp + their full list of engagement/activity codes with tags, and returns structured data:

**Input:**
```
Message: "Just finished a 30 minute SAP ITGC meeting with the Apple team"
Current time: 2026-02-15T14:00:00
User's codes: [E-1234567 Apple FY26 → 461 SAP ITGCs (tags: SAP, SAP meetings...), ...]
```

**Output:**
```json
{
  "entries": [{
    "engagementCode": "E-1234567",
    "engagementName": "Apple FY26",
    "activityCode": "461",
    "activityName": "SAP ITGCs",
    "date": "2026-02-15",
    "startTime": "13:30",
    "endTime": "14:00",
    "durationMinutes": 30,
    "description": "SAP ITGC meeting with the Apple team",
    "confidence": 0.95
  }],
  "reasoning": "'just finished' at 2:00 PM, duration 30 min → 1:30-2:00 PM. 'SAP ITGC' matches Activity 461 tags. 'Apple team' matches Engagement E-1234567."
}
```

> **Note:** The LLM returns human-readable times ("13:30", "14:00"). The frontend converts these to minutes-since-midnight integers (810, 840) before saving to the database. See Section 4.1 for the storage schema.

The AI handles:
- **Temporal reasoning**: "just finished" + current time + duration = start/end times
- **Fuzzy matching**: "SAP meeting" → Activity 461 (SAP ITGCs)
- **Negation**: "I didn't work on Apple today" → AI understands to exclude Apple
- **Multi-entry parsing**: One message can produce multiple timesheet entries
- **Ambiguity**: Low-confidence matches are flagged for user review

### 2.5 Confirmation Flow

Every user submission (voice or text) results in the timeline for the day being updated. 
If the program thinks its a low match rate, we can have a visual indicator that the user should review this block. 
Every block in the timeline should have the ability to edit, so that users can override what engagement/activity code it was assigned to. 

### 2.6 Daily Timeline View
A vertical timeline from 8:00 AM to 6:00 PM (configurable) showing color-coded blocks for each time entry:
- Each block shows the engagement name, activity name, and duration
- Blocks are colored by engagement for visual grouping
- Clicking a block opens it for editing
- Gaps in the timeline are visible (untracked time)
- The current time is marked with a line/indicator

### 2.7 Weekly Timesheet Summary View
A table summarizing the week's hours:

| Engagement | Activity | Mon (2/16) | Tue (2/17) | Wed (2/18) | Thu (2/19) | Fri (2/20) | Total |
|-----------|----------|-----------|-----------|-----------|-----------|-----------|-------|
| E-1234567 Apple FY26 | 461 SAP ITGCs | 2.0 | 3.5 | 1.0 | 4.0 | 2.5 | 13.0 |
| E-1234567 Apple FY26 | 462 Non-SAP ITGCs | 1.0 | 0.5 | 2.0 | 0.0 | 1.5 | 5.0 |
| E-7654321 Microsoft FY26 | 461 SAP ITGCs | 3.0 | 2.0 | 3.0 | 2.0 | 2.0 | 12.0 |
| **Total** | | **6.0** | **6.0** | **6.0** | **6.0** | **6.0** | **30.0** |

- Rows are auto-generated for each unique engagement+activity combination used during the week
- Hours are aggregated from daily timeline entries
- Week navigation (previous/next week)
- Manual cell editing for adjustments
- CSV export for submitting to external timesheet systems

---

## 3. Proposed Tech Stack

### 3.1 Desktop Application Framework: **Tauri 2**

**What it is:** Tauri 2 is a framework for building desktop (and mobile) apps using web technologies for the UI and Rust for the native backend layer.

**Frontend:** React + TypeScript (the most AI-friendly frontend stack - critical for LLM-assisted development)
**Backend:** Rust (thin layer handling system tray, audio recording, API calls, and native OS integration)

**Why Tauri 2:**

| Factor | Tauri 2 | Electron | Flutter |
|--------|---------|----------|---------|
| Binary size | ~5-10 MB | ~100+ MB | ~20-30 MB |
| Memory usage | ~30-40 MB idle | ~200-300 MB idle | ~80-120 MB idle |
| Startup time | < 0.5s | 1-2s | ~1s |
| macOS menu bar/tray | Native `tray` plugin | Supported | Community packages (less reliable) |
| iOS/mobile support | Built-in (Tauri 2 stable) | No | Yes (Flutter's strength) |
| App Store path | Documented | No | Yes |
| Frontend language | TypeScript/React | TypeScript/React | Dart |
| AI-friendliness (LLM training data) | Very high (React/TS) | Very high | Moderate (Dart is less common) |
| Web version reuse | React frontend IS a web app | React frontend IS a web app | Separate Flutter Web target |

**Key reasons for choosing Tauri over alternatives:**
1. **Memory footprint**: OmniSheet will run all day as a tray/menu bar app. Electron's 200-300MB idle usage is unacceptable for a background app. Tauri uses ~30MB.
2. **Mobile path**: Tauri 2 supports iOS builds from the same codebase. Electron has no mobile story. Flutter supports mobile but requires learning Dart.
3. **AI assistance**: The user will heavily rely on LLM assistance (never built an app before). React/TypeScript has the deepest pool of LLM training data. Dart/Flutter has significantly less.
4. **System tray**: First-class, well-maintained tray plugin vs Flutter's community packages.
5. **Web reusability**: The React frontend can be deployed as a standalone web app later with zero extra work.

**The Rust layer is thin:** System tray management, audio recording plugin, HTTP calls to OpenAI, and window configuration. The user spends 95% of development time in React/TypeScript.

### 3.2 UI Framework: **Tailwind CSS + shadcn/ui**

- **Tailwind CSS**: Utility-first CSS framework. Fast iteration, highly AI-friendly, avoids writing custom CSS.
- **shadcn/ui**: Pre-built, beautifully designed React components (buttons, forms, tables, cards, dialogs). Copy-paste into your project, fully customizable. Built on Tailwind.

### 3.3 Voice Transcription: **OpenAI Whisper API**

- **Cost**: $0.006 per minute of audio
- **Estimated monthly cost**: ~$0.90/month for a single user (10 entries/day × 15 sec avg × 30 days = 75 minutes)
- **Accuracy**: World-class speech-to-text, robust to varying microphone quality
- **Integration**: Single HTTP POST with the audio file, returns text transcript
- **Why not alternatives**:
  - Deepgram: More expensive for batch processing of short clips
  - Self-hosted Whisper: Requires GPU server ($276+/month) - absurd for 75 minutes of audio
  - Web Speech API: Free but inconsistent accuracy, browser-dependent

### 3.4 Message Interpretation: **OpenAI GPT-4o-mini (Structured Output)**

- **Cost**: $0.15 per 1M input tokens, $0.60 per 1M output tokens
- **Estimated monthly cost**: ~$0.02/month for a single user (300 requests × ~700 tokens avg)
- **Why an LLM is necessary** (not just keyword/regex matching):
  - **Temporal reasoning**: "just finished a 30 min meeting" + current time 2:00 PM → calculates 1:30-2:00 PM
  - **Fuzzy matching**: "non-sap itgc sync" → Activity Code 462 (matching against tags)
  - **Negation handling**: "I didn't work on Apple today" - keyword matching sees "Apple" and categorizes it; an LLM sees "didn't" and ignores it
  - **Multi-entry parsing**: "Spent two hours on X then switched to Y after lunch" → two separate entries
  - **Natural language understanding**: Handles slang, abbreviations, and conversational phrasing
- **Structured output**: GPT-4o-mini's function calling / structured output feature forces the response into a predefined JSON schema, ensuring consistent parsing
- **Scalability note**: With <50 active codes, send them all in the prompt. If codes grow to 100+, add a keyword pre-filter step to select the top 5 candidates before sending to the LLM.
- **Why GPT-4o-mini over Claude Haiku**: GPT-4o-mini is ~5x cheaper on input and ~7x cheaper on output. Both are more than capable for this structured extraction task. The provider can be swapped later if needed.

Certainly open to using other models though. Cheapness and speed is a premium. We're not doing heavy reasoning tasks, we're mostly interpeting the user intent and matching it based on a pre-defined list. 

### 3.5 Database: **SQLite (Local-First) via Drizzle ORM**

- **SQLite**: A file-based relational database that lives inside the app. No server, no network, works offline.
- **Drizzle ORM**: TypeScript-native ORM that provides type-safe database queries. Define your schema once in TypeScript, get auto-complete and type checking for all queries.
- **Why local-first**:
  - Instant reads/writes (no network latency)
  - Works offline (log time on a plane, in a dead zone)
  - Zero infrastructure cost
  - Simple to debug (the database is a single file)
  - Your data is small (~10K rows after years of use; SQLite handles millions)
- **Why not PostgreSQL/Supabase from day 1**: Overkill for a single user. Adds cloud dependency, network latency, and setup complexity. SQLite is simpler and more resilient.
- **Cloud sync later**: When team features are needed, add Supabase PostgreSQL (free tier: 500MB storage, 2 projects) to sync engagement codes and optionally timesheet data across team members.

### 3.6 Server Strategy: **Progressive (None → Supabase Edge Functions)**

**Phase 1 (Solo/MVP): No server.**
The Tauri Rust backend calls OpenAI APIs (Whisper + GPT-4o-mini) directly. The API key is stored in a local configuration file. This is acceptable for personal use and eliminates all infrastructure costs.

**Phase 2+ (Team/Production): Supabase Edge Functions (free tier).**
When the app goes to a team, API calls move behind Supabase Edge Functions (serverless TypeScript functions). This:
- Centralizes the OpenAI API key (no longer on each client)
- Provides a cloud PostgreSQL database for shared engagement codes and team sync
- Includes authentication (Supabase Auth)
- Free tier: 500K Edge Function invocations/month (you'll use ~300-1500)

**Why Supabase over a dedicated server (Railway, Fly.io):**
- Supabase bundles server functions + database + auth in one platform, all on the free tier
- No separate server to manage, deploy, or pay for
- Edge Functions are TypeScript (same language as the frontend)

### 3.7 Audio Recording: **tauri-plugin-audio-recorder**

A Tauri plugin providing cross-platform audio recording for desktop (Windows, macOS, Linux) and mobile (iOS, Android). JavaScript API includes `startRecording()`, `stopRecording()`, `getDevices()`, `checkPermission()`, and `requestPermission()`.

### 3.8 Full Tech Stack Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Desktop framework | Tauri 2 | Native desktop app with system tray, small binary, iOS path |
| Frontend | React + TypeScript | UI components, views, user interaction |
| UI styling | Tailwind CSS | Utility-first CSS, fast iteration |
| UI components | shadcn/ui | Pre-built buttons, forms, tables, cards, dialogs |
| Desktop backend | Rust (thin) | System tray, audio recording, API calls, window management |
| Voice transcription | OpenAI Whisper API | Speech-to-text ($0.006/min) |
| Message interpretation | OpenAI GPT-4o-mini | Structured extraction from unstructured text (~$0.02/mo) |
| Local database | SQLite via Drizzle ORM | Local-first data storage, offline support |
| Cloud database (later) | Supabase PostgreSQL | Team sync, shared engagement codes |
| Server (later) | Supabase Edge Functions | API key management, team features |
| Audio recording plugin | tauri-plugin-audio-recorder | Cross-platform mic access |
| Auth (later) | Supabase Auth | Team login, user management |

---

## 4. Data Model

### 4.1 Schema

```
Engagements
  - id: TEXT (UUID, primary key)
  - code: TEXT (e.g., "E-1234567")
  - name: TEXT (e.g., "Apple FY26")
  - client: TEXT (e.g., "Apple Inc.")
  - tags: TEXT (JSON array, e.g., '["Apple", "Apple team", "Apple audit"]')
  - isActive: INTEGER (boolean, 0 or 1)
  - createdAt: INTEGER (unix timestamp)
  - updatedAt: INTEGER (unix timestamp)

Activities
  - id: TEXT (UUID, primary key)
  - engagementId: TEXT (foreign key → Engagements.id)
  - code: TEXT (e.g., "461")
  - name: TEXT (e.g., "SAP ITGCs")
  - tags: TEXT (JSON array, e.g., '["SAP ITGC", "SAP", "SAP meetings"]')
  - isActive: INTEGER (boolean)
  - createdAt: INTEGER (unix timestamp)

TimesheetEntries
  - id: TEXT (UUID, primary key)
  - engagementId: TEXT (foreign key → Engagements.id)
  - activityId: TEXT (foreign key → Activities.id)
  - date: TEXT (ISO date, e.g., "2026-02-15")
  - startMinute: INTEGER (minutes since midnight, e.g., 810 for 13:30)
  - endMinute: INTEGER (minutes since midnight, e.g., 840 for 14:00)
  - durationMinutes: INTEGER (e.g., 30)
  - description: TEXT (cleaned up notes for this entry)
  - source: TEXT ("voice" | "text" | "manual")
  - rawMessageId: TEXT (foreign key → RawMessages.id, nullable)
  - createdAt: INTEGER (unix timestamp)
  - updatedAt: INTEGER (unix timestamp)

RawMessages
  - id: TEXT (UUID, primary key)
  - rawText: TEXT (original transcribed or typed text)
  - audioFilePath: TEXT (local path to audio file, nullable)
  - interpretedEntries: TEXT (JSON, the LLM's full parsed output)
  - confidence: REAL (0.0 - 1.0, overall confidence of interpretation)
  - status: TEXT ("pending" | "processed")
  - messageTimestamp: INTEGER (unix timestamp of when the user sent the message)
  - createdAt: INTEGER (unix timestamp)
```

### 4.2 Design Decisions
- **RawMessages** stores the original input alongside the LLM's interpretation. This allows users to review, correct, and re-interpret entries. It also creates an audit trail.
- **Tags** are stored as JSON arrays in TEXT columns. SQLite supports JSON functions for querying, but primarily these are sent to the LLM as context, not queried directly.
- **startMinute/endMinute** are stored as integers (minutes since midnight) for local-time simplicity without timezone math, trivial overlap detection via integer comparison, and easy display conversion (e.g., 810 → "1:30 PM"). The LLM returns human-readable times ("13:30"); the frontend converts to integers before saving.
- **durationMinutes** is stored explicitly (not computed from start/end) because some entries might specify "2 hours on X" without specific start/end times.
- **source** tracks whether the entry came from voice, text, or manual input for analytics.

---

## 5. Processing Flow

### 5.1 Text Input Flow

```
Step 1: User types message
  "Just finished a 30 minute SAP ITGC meeting with the Apple team"
  App captures: { rawText, timestamp: "2026-02-15T14:00:00" }

Step 2: Save RawMessage to SQLite

Step 3: Build LLM prompt
  - System prompt: "You are a timesheet assistant. Given the user's message
    and current time, extract timesheet entries. Match to the engagement/activity
    codes listed below. Return structured JSON."
  - Include: full list of active engagement codes + activity codes + tags
  - Include: user's message + timestamp
  - Include: expected JSON output schema

Step 4: Call GPT-4o-mini (from Tauri Rust backend)
  → Receives structured JSON with entries, confidence scores, reasoning

Step 5: Save TimesheetEntry to SQLite immediately
  - Frontend converts LLM-returned times ("13:30") to integers (810) before saving
  - Low-confidence entries (below threshold) are flagged with a visual indicator

Step 6: Timeline view re-renders with the new block(s)
  - All blocks are editable inline (user can change engagement, activity, times, description)
  - Low-confidence blocks show a visual indicator prompting review
```

### 5.2 Voice Input Flow

Same as text flow, but with a transcription step at the beginning:

```
Step 1: User records voice (via tray icon or in-app button)
  Audio saved as WAV/M4A file locally

Step 2: Send audio to OpenAI Whisper API (from Tauri Rust backend)
  → Receives text transcript

Step 3: Save RawMessage to SQLite with rawText (transcript) + audioFilePath

Step 4-6: Identical to text flow (from "Build LLM prompt" onward)
  → LLM interprets → save entry immediately → update timeline
  → Low-confidence entries get visual indicator; all blocks editable inline
```

### 5.3 Flow Diagram

```
[User speaks or types]
        │
        ├── (if voice) ──→ [Save audio file locally]
        │                         │
        │                         ▼
        │                  [Whisper API → transcript]
        │                         │
        ▼                         ▼
[Capture text + timestamp]
        │
        ▼
[Save RawMessage]
        │
        ▼
[Load user's engagement/activity codes + tags from SQLite]
        │
        ▼
[Build prompt + call GPT-4o-mini]
        │
        ▼
[Receive structured JSON entries]
        │
        ▼
[Convert times to integers + save TimesheetEntry immediately]
        │
        ▼
[Update timeline with new block(s)]
        │
        ├── (low confidence?) → [Show visual indicator for review]
        │
        └── [User edits blocks in-place if needed]
```

---

## 6. Architecture Diagram

```
Phase 1 (MVP - $0 infrastructure, ~$1/mo API costs):

+----------------------------------------------------------+
|                  TAURI 2 DESKTOP APP                      |
|                                                           |
|  +-------------------+  +----------------------------+   |
|  | Rust Backend       |  | React + TypeScript Frontend|   |
|  |                    |  |                            |   |
|  | - System tray /    |  | - Message input (text)     |   |
|  |   menu bar         |  | - Daily timeline view      |   |
|  | - Audio recording  |  |   (6am-6pm, color blocks)  |   |
|  | - HTTP calls to    |  | - Weekly timesheet table   |   |
|  |   OpenAI APIs:     |  |   (Mon-Fri, hours grid)    |   |
|  |   • Whisper        |  | - Engagement/activity      |   |
|  |   • GPT-4o-mini    |  |   code onboarding          |   |
|  | - Window mgmt      |  | - Settings                 |   |
|  |                    |  |                            |   |
|  +--------+-----------+  +-------------+--------------+   |
|           |                             |                  |
|           | Tauri IPC (returns          |                  |
|           | LLM/audio results)          |                  |
|           |                             |                  |
|           +----------+   +-------------v--------------+   |
|                      |   | Local SQLite               |   |
|                      |   | (Drizzle ORM - owned by    |   |
|                      |   |  React/TS frontend)        |   |
|                      |   |                            |   |
|                      |   | Tables:                    |   |
|                      |   | - Engagements              |   |
|                      |   | - Activities               |   |
|                      |   | - TimesheetEntries         |   |
|                      |   | - RawMessages              |   |
|                      |   +----------------------------+   |
+----------------------------------------------------------+
           |
           | HTTPS (from Rust backend)
           v
  +------------------+
  | OpenAI API       |
  | - Whisper        |
  | - GPT-4o-mini    |
  | ~$1/mo solo user |
  +------------------+


Phase 2+ (Team - $0 infrastructure, ~$4/mo API costs for 5 users):

+----------------------------------------------------------+
|                  TAURI 2 DESKTOP APP                      |
|  (same as above, but API calls route through Supabase)   |
+-----------------------------+----------------------------+
                              |
               +--------------v--------------+
               | Supabase (free tier)        |
               |                             |
               | Edge Functions:             |
               |  - /interpret (text→entries)|
               |  - /transcribe (audio→text) |
               |  - Calls OpenAI APIs        |
               |                             |
               | PostgreSQL:                 |
               |  - Shared engagement codes  |
               |  - Team sync               |
               |                             |
               | Auth:                       |
               |  - Team login              |
               |  - User management         |
               +-----------------------------+
```

---

## 7. Cost Estimates

### Single User (Phase 1)

| Service | Usage/Month | Cost/Month |
|---------|-------------|-----------|
| OpenAI Whisper | ~75 min audio (10 entries/day × 15 sec × 30 days) | $0.45 |
| OpenAI GPT-4o-mini | ~300 requests × ~700 tokens | $0.02 |
| Server hosting | None (API calls from app) | $0.00 |
| Database hosting | Local SQLite | $0.00 |
| **Total** | | **$0.47/month** |

### Team of 5 (Phase 2+)

| Service | Usage/Month | Cost/Month |
|---------|-------------|-----------|
| OpenAI Whisper | ~375 min audio | $2.25 |
| OpenAI GPT-4o-mini | ~1,500 requests | $0.10 |
| Supabase Edge Functions | ~1,500 invocations (free tier: 500K) | $0.00 |
| Supabase PostgreSQL | <100MB (free tier: 500MB) | $0.00 |
| Supabase Auth | 5 users (free tier: 50K MAU) | $0.00 |
| **Total** | | **$2.35/month** |

### One-Time Costs
| Item | Cost |
|------|------|
| Apple Developer Program (for App Store) | $99/year |
| OpenAI API account | Free to create |

---

## 8. Implementation Plan

### Phase 1: Foundation + Text Input (Weeks 1-3)

**Goal:** Type a message → AI interprets it → see it on a daily timeline.

**Tasks:**
1. **Project scaffolding**
   - Initialize Tauri 2 project with React + TypeScript template (`npm create tauri-app@latest`)
   - Set up Tailwind CSS and shadcn/ui
   - Verify the app builds and runs on Windows
   - Set up Git repository

2. **Database setup**
   - Install Drizzle ORM + better-sqlite3
   - Define schema for all 4 tables (Engagements, Activities, TimesheetEntries, RawMessages)
   - Run migrations to create tables
   - Seed with sample data (2-3 engagement codes with activities and tags)

3. **Engagement/activity code onboarding UI**
   - Form to add a new engagement (code, name, client, tags)
   - Form to add activities under an engagement (code, name, tags)
   - List view of all engagements and their activities
   - Edit and delete functionality
   - Tag input component (add/remove tags)

4. **LLM interpretation (Rust backend)**
   - Tauri command that accepts text + timestamp
   - Loads active engagement/activity codes from SQLite
   - Builds the system prompt with codes and tags
   - Calls GPT-4o-mini via HTTP (reqwest crate)
   - Parses structured JSON response
   - Returns interpreted entries to the frontend

5. **Text input + auto-save flow**
   - Message input component (text box + submit button)
   - Loading state while waiting for LLM response
   - Auto-save interpreted entries to SQLite (no confirmation gate)
   - Low-confidence visual indicator on timeline blocks that need review
   - Inline block editing (change engagement, activity, times, description)

6. **Daily timeline view**
   - Vertical timeline from 6am to 6pm
   - Render time entry blocks with engagement color coding
   - Show engagement name, activity name, duration on each block
   - Current time indicator
   - Click block to view/edit details
   - Date navigation (previous/next day)

### Phase 2: Voice Input + System Tray (Weeks 4-5)

**Goal:** Click the menu bar / tray icon → speak → see it on the timeline.

**Tasks:**
1. **Audio recording**
   - Install and configure `tauri-plugin-audio-recorder`
   - Record button in UI (start/stop)
   - Save audio files locally (WAV or M4A format)
   - Audio permission handling (request microphone access)

2. **Whisper transcription**
   - Tauri command that accepts audio file path
   - Sends audio to OpenAI Whisper API
   - Returns transcript text
   - Error handling for failed transcriptions

3. **System tray integration**
   - Add system tray icon via Tauri tray plugin
   - Right-click context menu: "Record", "Stop", "Open App", "Quit"
   - macOS: position as menu bar app (top bar)
   - Windows: system tray icon (bottom-right)
   - Recording state indicator (icon change while recording)

4. **End-to-end voice flow**
   - Click tray "Record" → start recording
   - Click tray "Stop" → stop recording → transcribe → interpret → auto-save → update timeline
   - Full pipeline: voice → Whisper → GPT-4o-mini → save entry → timeline update

### Phase 3: Weekly Timesheet Summary (Weeks 6-7)

**Goal:** See a weekly summary table ready for timesheet submission.

**Tasks:**
1. **Weekly summary table**
   - Query all TimesheetEntries for the selected week
   - Group by unique (engagementCode + activityCode) combinations
   - Display as table: rows = engagement+activity, columns = Mon-Fri
   - Calculate and display hours per cell
   - Total row and total column
   - Week navigation (previous/next)

2. **Manual entry editing**
   - Click any cell to add/edit hours
   - Add a new row manually (select engagement + activity)
   - Delete entries

3. **Data export**
   - Export weekly timesheet as CSV
   - Format compatible with common timesheet systems
   - Include engagement code, activity code, daily hours, and total

4. **Settings page**
   - Configurable working hours (default 6am-6pm)
   - Default engagement (for unmatched entries)
   - OpenAI API key management

### Phase 4: Cloud Sync + Multi-User (Weeks 8-10)

**Goal:** Team members share engagement codes and optionally sync data.

**Tasks:**
1. **Supabase setup**
   - Create Supabase project
   - Set up Edge Functions for /interpret and /transcribe endpoints
   - Move OpenAI API calls from Rust backend to Edge Functions
   - Mirror database schema in Supabase PostgreSQL

2. **Authentication**
   - Supabase Auth integration (email/password or magic link)
   - Login/signup screens in the app
   - Session management

3. **Team features**
   - Shared engagement/activity codes (admin creates, team sees)
   - Personal vs. shared codes
   - Sync timesheet entries to cloud (optional per user)

### Phase 5: iOS + macOS Polish (Weeks 11+)

**Goal:** iPhone app and macOS Liquid Glass UI.

**Tasks:**
1. **iOS build**
   - `tauri ios init`
   - Adapt UI layout for phone form factor
   - Test audio recording on iOS (permission handling)
   - Test in iOS Simulator and on physical device

2. **macOS polish**
   - Liquid Glass design elements (vibrancy, translucency via Tauri macOS window APIs and CSS `backdrop-filter`)
   - Native macOS menu bar positioning refinement

3. **App Store submission**
   - Privacy policy (microphone usage disclosure)
   - App icons and screenshots
   - Submit to Mac App Store and iOS App Store via Xcode / altool

---

## 9. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **LLM interprets messages incorrectly** | Wrong engagement/activity code or times | Low-confidence visual indicator; all timeline blocks editable inline; tags improve matching accuracy |
| **Tauri 2 mobile support is young** | iOS build issues | Tauri 2.0 is stable; the app is simple (webview + audio); can fall back to React Native or Capacitor wrapper for iOS if needed |
| **User has never built an app** | Slower development, more roadblocks | React/TypeScript is the most LLM-assistable stack; AI coding tools (Claude Code, Cursor) generate excellent React/TS code |
| **OpenAI API changes or outages** | App stops working temporarily | Local SQLite means data is safe; can swap to another LLM provider (Claude Haiku, Gemini) with minimal changes; add retry logic |
| **Audio quality varies** | Poor transcription | Whisper is robust to quality variations; short clips (5-30s) have high accuracy; text input is always available as fallback |
| **Engagement code list grows very large** | LLM prompt becomes expensive | Add pre-filter step: keyword match to top 5 candidates, send only those to LLM; unlikely to be needed with <50 active codes |

---

## 10. Open Questions for Review

1. **How should overlapping time blocks be handled?** If a user logs a 1:00-2:00 PM entry and then a 1:30-2:30 PM entry, should the app warn about the overlap, auto-adjust, or allow it?

2. **Should the weekly summary support half-day or quarter-hour granularity?** The example shows hours as decimals (2.5). Is 15-minute granularity sufficient, or do you need 6-minute (0.1 hour) increments?

3. **Multi-device sync priority**: When team features are added, should timesheet entries sync to the cloud by default (collaborative), or remain local by default (private) with opt-in sync?

4. **LLM provider flexibility**: The plan uses OpenAI (Whisper + GPT-4o-mini). Should the architecture abstract the LLM provider to make it easy to swap to Claude, Gemini, or a local model later?
