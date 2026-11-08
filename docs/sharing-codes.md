# Sharing engagement codes

Use **Settings > Engagement codes** to share codes separately from the app installer.

## Export

Choose **Choose engagements…**, select the engagements to include, and choose **Export JSON…**.
Search filters the list without clearing your selections. **Select all matching** adds the visible
results to your selection; **Clear selection** clears everything. Active and inactive engagements
are listed separately.

Each selected engagement includes all of its activities, including inactive activities. The file
includes names, codes, client names, engagement type, colors, tags, descriptions, and active status.
It excludes database IDs, time entries, notes, settings, diagnostics, and credentials.

## Import

Choose **Import…** and select a file previously exported by OmniSheet. Selecting a valid file
immediately saves new engagements; there is no additional confirmation. Canceling the file picker
does nothing. Completion reports the number of engagements and activities added and engagements skipped.

An engagement with an existing code is skipped, together with all its activities. Code matching
ignores leading/trailing whitespace and letter case. Engagements without codes are matched by name
and client, ignoring letter case and repeated whitespace. Different nonempty codes remain distinct.
Import never changes existing engagements or adds activities to existing engagements.

The entire file is validated before saving. Invalid files, unsupported versions, duplicate engagement
identities, and duplicate activity codes within an engagement are rejected. All additions are saved in
one transaction. An insertion failure rolls back the entire import.

## File format and private sharing

The UTF-8 JSON envelope uses `format: "omnisheet.codes"`, `version: 1`, an RFC 3339 `exportedAt`,
and an `engagements` array with nested `activities`. Fields use camelCase. Files are limited to
5 MB, 5,000 engagements, and 50,000 activities. Unknown fields are rejected. New local IDs and
creation/update timestamps are assigned on import.

Share actual code files through a private channel. Default `OmniSheet-codes-*.json` filenames are
ignored by Git and rejected by the public-file hygiene check. Renaming a file does not make its
contents public-safe; keep privately named files in the ignored `exports/` directory or outside the repo.
Diagnostics do not record imported/exported contents or selected file paths.
