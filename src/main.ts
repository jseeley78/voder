import './style.css'
import { initUI } from './ui'

declare const __GIT_HASH__: string
declare const __BUILD_TIME__: string

initUI()

// Show build version
const el = document.getElementById('buildInfo')
if (el) el.textContent = `${__GIT_HASH__} · ${__BUILD_TIME__}`
