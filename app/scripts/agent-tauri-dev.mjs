import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(scriptDir, '..')
const repoRoot = resolve(appDir, '..')
const logDir = resolve(repoRoot, '.codex', 'logs')
const qaDataDir = resolve(repoRoot, '.codex', 'agent-qa')
const qaDbPath = resolve(qaDataDir, 'omnisheet-agent-qa.db')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outPath = resolve(logDir, `agent-tauri-dev-${stamp}.out.log`)
const errPath = resolve(logDir, `agent-tauri-dev-${stamp}.err.log`)

mkdirSync(logDir, { recursive: true })
mkdirSync(qaDataDir, { recursive: true })

const outLog = createWriteStream(outPath, { flags: 'a' })
const errLog = createWriteStream(errPath, { flags: 'a' })
const command = process.platform === 'win32' ? 'npm run tauri dev' : 'npm'
const commandArgs = process.platform === 'win32' ? [] : ['run', 'tauri', 'dev']

console.log('Starting OmniSheet Agent QA desktop run...')
console.log(`QA database: ${qaDbPath}`)
console.log(`stdout log: ${outPath}`)
console.log(`stderr log: ${errPath}`)

const child = spawn(command, commandArgs, {
  cwd: appDir,
  env: {
    ...process.env,
    OMNISHEET_DATABASE_PATH: qaDbPath,
    OMNISHEET_AGENT_QA: '1',
    OMNISHEET_AGENT_QA_RESET: '1',
  },
  shell: process.platform === 'win32',
  stdio: ['inherit', 'pipe', 'pipe'],
})

child.stdout.pipe(process.stdout)
child.stdout.pipe(outLog)
child.stderr.pipe(process.stderr)
child.stderr.pipe(errLog)

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal)
  }
}

process.on('SIGINT', () => forwardSignal('SIGINT'))
process.on('SIGTERM', () => forwardSignal('SIGTERM'))

child.on('exit', (code, signal) => {
  outLog.end()
  errLog.end()

  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 0)
})
