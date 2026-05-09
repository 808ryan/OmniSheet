#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: ./scripts/prepare-apple-certificate-secret.sh /path/to/certificate.p12" >&2
  exit 1
fi

certificate_path="$1"
encoded="$(base64 < "$certificate_path" | tr -d '\n')"

printf '%s\n' "$encoded"

if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$encoded" | pbcopy
  echo "Copied APPLE_CERTIFICATE value to clipboard." >&2
fi
