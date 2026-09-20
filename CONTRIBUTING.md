# Contributing

Use the setup and validation commands in the [development guide](docs/development.md). Keep changes focused and explain the problem, resulting behavior, and checks performed in your pull request.

For bug reports, include the operating system, app version, reproduction steps, and expected behavior. Use synthetic examples. Do not upload API keys, local databases, real calendar screenshots, client names, billing codes, or unredacted diagnostic logs.

Add regression tests for behavior changes. Frontend tests live in `app/tests/`; Rust tests live alongside the backend modules. For UI changes, describe any desktop testing separately from automated checks.

Application data, signing material, exports, local agent instructions, and personal planning notes do not belong in this repository. Review both `git diff --cached` and staged filenames before committing.
