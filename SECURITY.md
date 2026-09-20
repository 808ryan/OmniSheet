# Security

Do not put credentials, confidential work data, or exploit details in a public issue.

If GitHub's private vulnerability reporting is enabled, use the repository's **Security → Report a vulnerability** option. Otherwise, open an issue asking the maintainer for a private reporting channel without including sensitive details.

For an accidentally exposed credential, revoke or rotate it at its provider. Removing a file in a later commit does not remove its earlier copies from Git history, pull requests, build logs, caches, or downloaded releases.

OmniSheet stores its application database locally without application-level encryption. Optional AI features submit content to OpenAI. See the data and privacy section of [README.md](README.md) before using confidential information.
