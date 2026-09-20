import { execFileSync } from 'node:child_process'

// Audit tracked filenames only: local databases and credentials must never enter Git.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const paths = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean)
const disallowed = [
  /(^|\/)(?:AGENTS\.md|\.claude|\.codex|\.agents|\.npm-cache)(?:\/|$)/i,
  /(^|\/)(?:Proposed_Plan\.md|Brainstorming\.txt|implementation_status\.md)$/i,
  /(^|\/)\.env(?:\..+)?$/i,
  /\.(?:db(?:-.*)?|sqlite(?:3)?(?:-.*)?|p8|p12|pfx|pem|key|mobileprovision)$/i,
  /^(?:personal-data|scratch|exports|OmniSheetApp)\//i,
  /^cal\d+\.png$/i,
]
const violations = paths.filter((path) => disallowed.some((pattern) => pattern.test(path)))
if (violations.length) {
  console.error('Remove private/local files from Git before publishing:\n' + violations.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Checked ${paths.length} tracked filenames: no private/local file patterns found.`)
}
