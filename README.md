# OmniSheet

OmniSheet is a desktop timesheet and time-tracking app with optional AI assistance and built-in reporting. It's made for work that spans multiple projects and activity codes, with weekly Excel exports to help you get your timesheet ready to submit.

## How it works

- **Track your work.** Start a timer, add time manually, or open the quick-entry window without leaving what you're working on.
- **Describe what you did.** Type or speak a time entry and let an LLM help turn it into structured entries using your projects and activity codes. You can also extract entries from a calendar image.
- **Review your week.** See entries on a daily or weekly timeline and drag blocks to adjust them.
- **Prepare your timesheet.** Organize time by project and activity code, choose your report columns, and export to Excel for weekly submission.

New installations include Public Holiday, Vacation, and a fictional Orange FY26 project with one example activity, RSK - SAP ITGCs. Edit or delete the example and add your own projects (called engagements in the app) and activity codes. Manual entries and timers work without an API key. AI features use your own OpenAI API key.

## Running OmniSheet

For now, run OmniSheet from source. Once you've installed the prerequisites in the [development guide](docs/development.md):

```sh
cd app
npm ci
npm run tauri dev
```

## Your data

Time entries, projects, settings, and diagnostics stay in a local database on your computer. The database isn't encrypted by OmniSheet. Your API key is kept in your operating system's credential store when available; otherwise, it's kept only for the current session.

When you use an AI feature, the text, audio, or image you submit and relevant project context are sent to OpenAI. Diagnostic logs can include entry text, so check them before sharing a bug report.

## Contributing

See the [development guide](docs/development.md) for setup and checks, [contribution guidelines](CONTRIBUTING.md) for changes and bug reports, and [security policy](SECURITY.md) for reporting vulnerabilities.

## License

[MIT](LICENSE).
