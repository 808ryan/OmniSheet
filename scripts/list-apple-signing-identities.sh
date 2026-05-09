#!/usr/bin/env bash

set -euo pipefail

security find-identity -v -p codesigning | grep "Developer ID Application"
