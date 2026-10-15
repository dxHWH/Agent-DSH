/**
 * Optional branding patch for the DSH web frontend (`npm run brand`).
 *
 * DSH has no branding extension point, so this rewrites three functions in the
 * installed (minified) bundles. Idempotent: each replaced function carries a
 * marker comment, and a re-run locates the function by that marker when the
 * original signature is gone. Run it again after every `npm ci` / DSH upgrade
 * (a fresh install restores the stock bundles).
 *
 *  - BrandWordmark  → neutral mark (inline SVG) + "Agent Desktop"
 *  - FishLogo       → null (drop the standalone stock mark)
 *  - HeroFish       → neutral mark, larger (new-session empty state)
 *  - hero.headline  → "Agent Desktop"; hero.preview → ""
 *
 * Signatures are tied to DSH 0.1.5-rc.2 (`index-BKQ_L1z6.js`); after a DSH
 * upgrade, find the new bundle name and signatures and update the constants.
 * Skipping this script is safe: the app then shows the stock DSH branding.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets', 'index-BKQ_L1z6.js')
const CLIENT = join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js')

const PRODUCT = 'Agent Desktop'
const MARK_WM = '/*__AGENT_DESKTOP_WORDMARK__*/'
const MARK_FISH = '/*__AGENT_DESKTOP_FISHLOGO__*/'
const MARK_HERO = '/*__AGENT_DESKTOP_HERO__*/'
const SIG_WM = 'function uC({size:t=24,className:r,includeMark:i=!0})'
const SIG_FISH = 'function cC({size:t=24,className:r})'
const SIG_HERO = 'function HeroFish({ hovering })'

/** The same mark as `assets/icon.svg`: dark rounded tile, blue chevron + cursor. */
const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#1a1a1a"/>' +
  '<path d="M23 21.8 37.1 32 23 42.2" fill="none" stroke="#4c8dff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M39.7 42.2h8.9" stroke="#4c8dff" stroke-width="6" stroke-linecap="round"/></svg>'
const MARK_URI = `data:image/svg+xml;base64,${Buffer.from(MARK_SVG).toString('base64')}`

/** Find the balanced function body after the param list. Returns [start, end]. */
function findBody(text, fnStart) {
  let i = fnStart
  let paren = 0
  let sawParen = false
  for (; i < text.length; i++) {
    const c = text[i]
    if (!sawParen) { if (c === '(') { sawParen = true; paren = 1 } continue }
    if (c === '(') paren++
    else if (c === ')') { paren--; if (paren === 0) break }
  }
  while (i < text.length && text[i] !== '{') i++
  let depth = 0
  for (; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return [fnStart, i] }
  }
  throw new Error('unbalanced body')
}

/** Find the current extent of a (possibly previously replaced) function. */
function locateCurrent(text, signature, marker) {
  const mk = text.indexOf(marker)
  if (mk >= 0) return [mk, findBody(text, mk + marker.length)[1]]
  const sig = text.indexOf(signature)
  if (sig >= 0) return findBody(text, sig)
  throw new Error(`neither signature nor marker found: ${signature}`)
}

function patchWebBundle() {
  if (!existsSync(BUNDLE)) {
    console.warn(`[brand] skipped: ${BUNDLE} not found (DSH version changed?)`)
    return
  }
  let text = readFileSync(BUNDLE, 'utf8')
  {
    const [s, e] = locateCurrent(text, SIG_FISH, MARK_FISH)
    text = text.slice(0, s) + `${MARK_FISH}function cC({size:t=24,className:r}){return null}` + text.slice(e + 1)
    console.log('[brand] FishLogo -> null')
  }
  {
    const [s, e] = locateCurrent(text, SIG_WM, MARK_WM)
    const replacement =
      MARK_WM +
      'function uC({size:t=24,className:r,includeMark:i=!0}){' +
      'return d.jsxs("span",{className:"agent-desktop-brand"+(r?" "+r:""),style:{display:"inline-flex",alignItems:"center",gap:"0.4em"},children:[' +
      `i?d.jsx("img",{src:${JSON.stringify(MARK_URI)},alt:"",draggable:!1,style:{display:"block",height:Math.round(t*1.05),width:"auto",borderRadius:"22%"}}):null,` +
      `d.jsx("span",{style:{color:"currentColor",fontWeight:600,fontSize:Math.round(t*0.6),lineHeight:1,whiteSpace:"nowrap"},children:${JSON.stringify(PRODUCT)}})` +
      ']})}'
    text = text.slice(0, s) + replacement + text.slice(e + 1)
    console.log(`[brand] BrandWordmark -> mark + "${PRODUCT}"`)
  }
  writeFileSync(BUNDLE, text, 'utf8')
  console.log(`[brand] wrote ${BUNDLE}`)
}

function patchConversationHero() {
  if (!existsSync(CLIENT)) {
    console.warn(`[brand] skipped: ${CLIENT} not found`)
    return
  }
  let text = readFileSync(CLIENT, 'utf8')
  {
    const [s, e] = locateCurrent(text, SIG_HERO, MARK_HERO)
    const replacement =
      MARK_HERO +
      'function HeroFish({hovering}){' +
      `return (0, react_jsx_runtime.jsx)("img",{src:${JSON.stringify(MARK_URI)},alt:"",draggable:false,style:{height:56,width:"auto",display:"block",borderRadius:"22%"}})}`
    text = text.slice(0, s) + replacement + text.slice(e + 1)
    console.log('[brand] HeroFish -> mark')
  }
  text = text.replace(/"hero\.headline":\s*"[^"]*"/, `"hero.headline": ${JSON.stringify(PRODUCT)}`)
  text = text.replace(/"hero\.preview":\s*"[^"]*"/, '"hero.preview": ""')
  writeFileSync(CLIENT, text, 'utf8')
  console.log(`[brand] wrote ${CLIENT}`)
}

patchWebBundle()
patchConversationHero()
