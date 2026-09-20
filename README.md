# OmniSheet

OmniSheet helps you track time across projects and activity codes and put together your weekly timesheet. Use a timer, enter hours yourself, or let AI turn a description of your work into time entries. Built-in reports let you review the week and export your timesheet to Excel.

## Logging time

- Start a timer while you work or add entries afterward.
- Type or speak what you worked on, and AI helps match it to your projects and activity codes.
- **Add entries in bulk from a calendar screenshot.** Upload a screenshot of your calendar view to extract multiple time entries, then review and adjust them before adding them to your timeline.
- Use the quick-entry window to log time without opening the full app.

You can review entries on a daily or weekly timeline and drag blocks to change their timing. When it's time to submit your timesheet, group your hours by project and activity code, choose the report columns you need, and export to Excel.

AI features use your own OpenAI API key. Manual entries, timers, and reporting work without one.

## Running OmniSheet

For now, run OmniSheet from source. Once you've installed the prerequisites in the [development guide](docs/development.md):

```sh
cd app
npm ci
npm run tauri dev
```

## Your data

Your time entries and settings are saved locally on your computer in an unencrypted database. Your API key is saved in your operating system's credential store when available, or kept for the current session otherwise.

Using an AI feature sends the text, audio, or screenshot you provide, along with relevant project context, to OpenAI. Diagnostic logs are also stored locally and can include entry text; check them before sharing a bug report.

## License

[MIT](LICENSE).
