import './style.css'
import { initUI } from './ui'

declare const __GIT_HASH__: string

initUI()

// Show build version — hash from git, timestamp updates each page load
const el = document.getElementById('buildInfo')
if (el) {
  const now = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  el.textContent = `${__GIT_HASH__} · ${now}`
}
