import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { CSS } from './styles.ts'

const style = document.createElement('style')
style.textContent = CSS
document.head.appendChild(style)

const rootEl = document.getElementById('root')
if (rootEl) createRoot(rootEl).render(<App />)
