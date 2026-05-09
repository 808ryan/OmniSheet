# Releasing OmniSheet for macOS

OmniSheet voice capture should be validated from a packaged macOS `.app`, not from `npm run tauri dev`. The dev runtime is best-effort for microphone support because it does not behave like an installed, signed app bundle in System Settings.

This document covers the full path:

1. Create or reuse a `Developer ID Application` certificate.
2. Create an App Store Connect `Team Key` for notarization.
3. Add the required GitHub repository secrets.
4. Run the `Release macOS` workflow.

## Before you start

- Creating a new `Developer ID Application` certificate does not break another app that is already using an older certificate.
- The risky action is revoking an old certificate or old API key. Do not revoke anything while setting up OmniSheet.
- Ignore old `.key` files for this workflow. OmniSheet signs from a `.p12` certificate export and an App Store Connect `.p8` API key.
- If you have an older `.p12` but do not trust its password, it is simpler to create a new certificate and export a fresh `.p12`.

## GitHub workflows in this repo

- `.github/workflows/ci.yml`
  - Runs on pull requests and pushes to `main`
  - Validates lint, frontend build, Rust formatting, and Rust compilation on Linux
- `.github/workflows/release-macos.yml`
  - Runs on `workflow_dispatch` and semver tags such as `v0.1.0`
  - Builds a signed, notarized macOS release on `macos-latest`
  - Creates a draft GitHub Release instead of publishing it automatically

## Step 1: Create a new Developer ID Application certificate on your Mac

Use this path unless you already know an existing `.p12` password and want to reuse it.

1. Open `Keychain Access`.
2. In the menu bar, click `Keychain Access` -> `Certificate Assistant` -> `Request a Certificate From a Certificate Authority...`
3. Fill in:
   - `User Email Address`: your Apple Developer email
   - `Common Name`: `OmniSheet Developer ID`
   - `CA Email Address`: leave blank
   - `Request is`: `Saved to disk`
4. Save the CSR file somewhere easy to find.
5. Open Apple Developer Certificates:
   - <https://developer.apple.com/account/resources/certificates/list>
6. Click `+`.
7. Choose `Developer ID Application`.
8. Upload the CSR.
9. Download the generated certificate.
10. Double-click the downloaded certificate so it installs into Keychain Access.
11. In `Keychain Access`, go to `login` -> `My Certificates`.
12. Find the certificate named like `Developer ID Application: Your Name (TEAMID)`.
13. Expand it and confirm it has a private key attached.

## Step 2: Export the certificate as a `.p12`

1. In `Keychain Access`, right-click the new `Developer ID Application` certificate.
2. Click `Export`.
3. Save it as something clear, for example `OmniSheet-DeveloperID.p12`.
4. Set a password you will remember.
5. Keep that password. It will become `APPLE_CERTIFICATE_PASSWORD`.

## Step 3: Capture the exact signing identity

On your Mac, open Terminal and run:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

Copy the exact identity text for the certificate you just created. It will look like:

```text
Developer ID Application: Your Name (TEAMID)
```

That exact string becomes `APPLE_SIGNING_IDENTITY`.

You can also use the helper script in this repo:

```bash
./scripts/list-apple-signing-identities.sh
```

## Step 4: Convert the `.p12` file into the GitHub secret value

### On Windows PowerShell

Run:

```powershell
.\scripts\prepare-apple-certificate-secret.ps1 -P12Path "C:\full\path\to\OmniSheet-DeveloperID.p12" -CopyToClipboard
```

This reads the `.p12`, prints the base64-encoded value, and copies it to the clipboard. That value becomes `APPLE_CERTIFICATE`.

If you prefer a one-liner:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\full\path\to\OmniSheet-DeveloperID.p12")) | Set-Clipboard
```

### On macOS

Run:

```bash
./scripts/prepare-apple-certificate-secret.sh /full/path/to/OmniSheet-DeveloperID.p12
```

If `pbcopy` is available, the script also copies the value to the clipboard.

## Step 5: Create a new App Store Connect Team API key

Use a `Team Key`, not an `Individual Key`.

1. Open App Store Connect:
   - <https://appstoreconnect.apple.com/>
2. Go to `Users and Access`.
3. Open `Integrations`.
4. Open `Team Keys`.
5. Click `Generate API Key`.
6. Name it something like `OmniSheet CI`.
7. Set the access level to `Admin`.
8. Generate the key.
9. Download the `.p8` file immediately. Apple only lets you download it once.
10. Capture these values:
    - `Key ID` -> `APPLE_API_KEY`
    - `Issuer ID` -> `APPLE_API_ISSUER`
    - Full contents of the downloaded `.p8` file -> `APPLE_API_KEY_P8`

## Step 6: Add the required GitHub repository secrets

Open the OmniSheet GitHub repository and go to:

`Settings` -> `Secrets and variables` -> `Actions`

Add these repository secrets exactly:

- `APPLE_CERTIFICATE`
  - Base64-encoded `.p12` from Step 4
- `APPLE_CERTIFICATE_PASSWORD`
  - Password you used when exporting the `.p12`
- `APPLE_SIGNING_IDENTITY`
  - Exact `Developer ID Application: ...` value from Step 3
- `APPLE_API_KEY`
  - App Store Connect Key ID
- `APPLE_API_ISSUER`
  - App Store Connect Issuer ID
- `APPLE_API_KEY_P8`
  - Full contents of the `.p8` file, including the `BEGIN PRIVATE KEY` and `END PRIVATE KEY` lines

The release workflow writes the `.p8` contents to a temporary file and exposes it through `APPLE_API_KEY_PATH` internally. Do not add `APPLE_API_KEY_PATH` as a GitHub secret.

## Step 7: Run the first signed macOS release

1. In GitHub, open `Actions`.
2. Open the `Release macOS` workflow.
3. Click `Run workflow`.
4. Enter a semver tag such as `v0.1.0`.
5. Wait for the workflow to finish.
6. Download the draft release artifact on your MacBook.
7. Open the app from Finder.
8. Click the microphone button and verify the macOS microphone permission prompt appears.

## Local build

Run the packaged macOS build from the `app/` directory:

```bash
npm run tauri build -- --target universal-apple-darwin
```

The app bundle includes `NSMicrophoneUsageDescription`, so the packaged app is the correct place to verify the first-run microphone permission prompt.
The macOS bundle now also includes an entitlements file with `com.apple.security.device.audio-input`, and OmniSheet proactively requests microphone permission through native AVFoundation before the web recorder starts.

## Troubleshooting

- Certificate import fails in GitHub Actions:
  - `APPLE_CERTIFICATE` or `APPLE_CERTIFICATE_PASSWORD` is wrong.
- Signing fails:
  - `APPLE_SIGNING_IDENTITY` does not exactly match the installed/exported certificate.
- Notarization fails:
  - `APPLE_API_KEY`, `APPLE_API_ISSUER`, or `APPLE_API_KEY_P8` is wrong.
- You cannot create a certificate or Team Key:
  - Your Apple account likely does not have enough permissions and you need the team `Account Holder` or an admin.

## Manual verification checklist

After downloading the CI-built artifact on a Mac:

1. Launch OmniSheet normally from Finder.
2. Confirm Gatekeeper allows the signed app to open without manual override.
3. Click the microphone button on first use.
4. Confirm macOS prompts for microphone access.
5. Allow access and verify recording starts.
6. Confirm voice transcription still completes end to end.

Optional command-line checks:

```bash
spctl -a -vvvv /path/to/OmniSheet.app
xcrun stapler validate /path/to/OmniSheet.dmg
codesign -d --entitlements :- /path/to/OmniSheet.app
tccutil reset Microphone com.omnisheet.desktop
```

`codesign -d --entitlements :-` should show `com.apple.security.device.audio-input`.
Use `tccutil reset` before re-testing the first-run prompt path for the same bundle identifier.

## Cost and trigger guidance

If the repository is private, GitHub-hosted macOS runners consume billed minutes. Keep the notarized macOS build on manual dispatches and release tags only; use the Linux validation workflow for normal day-to-day development.
