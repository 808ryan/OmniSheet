import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const isQuickAddWindow = new URLSearchParams(window.location.search).get('window') === 'quick-add'

if (isQuickAddWindow) {
  document.documentElement.classList.add('quick-add-document')
  document.body.classList.add('quick-add-window')
}

const root = createRoot(document.getElementById('root')!)

if (isQuickAddWindow) {
  void import('./QuickAdd.tsx').then(({ default: QuickAdd }) => {
    root.render(
      <StrictMode>
        <QuickAdd />
      </StrictMode>,
    )
  })
} else {
  void import('./App.tsx').then(({ default: App }) => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
}
