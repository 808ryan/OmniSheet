import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import QuickAdd from './QuickAdd.tsx'

const isQuickAddWindow = new URLSearchParams(window.location.search).get('window') === 'quick-add'

if (isQuickAddWindow) {
  document.documentElement.classList.add('quick-add-document')
  document.body.classList.add('quick-add-window')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isQuickAddWindow ? <QuickAdd /> : <App />}
  </StrictMode>,
)
