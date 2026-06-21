export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function isAgentMockRuntime(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_OMNISHEET_AGENT_MOCK === '1'
}

export function isAppRuntime(): boolean {
  return isTauriRuntime() || isAgentMockRuntime()
}
