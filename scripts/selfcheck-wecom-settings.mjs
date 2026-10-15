/**
 * 设置面板「企业微信归档机器人」卡片自检（真实 Electron + preload + IPC + wecom-cli）。
 *
 * 只用假凭证：验证卡片渲染、状态读取、错误凭证的提示、失败不覆盖正式凭证。
 * Run: npm run build && npx electron scripts/selfcheck-wecom-settings.mjs
 */
import { app, BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const results = []
const record = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` [${detail}]` : ''}`) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const credFiles = ['credentials.enc', '.encryption_key'].map((f) => join(homedir(), '.config', 'wecom', f))
const hash = () => credFiles.map((p) => existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null).join(',')

async function main() {
  const { registerSettingsIpc, openSettingsWindow } = await import('../dist/main/settings.js')
  registerSettingsIpc(() => null, () => 'C:\\fake\\profile')
  openSettingsWindow()
  await wait(1500)
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  record('settings window opens', !!win)
  if (!win) return
  win.setSize(900, 1300)
  const js = (code) => win.webContents.executeJavaScript(code)
  const el = (id, prop = 'textContent') => js(`document.getElementById(${JSON.stringify(id)})?.${prop}`)

  record('wecom card rendered', (await js(`!!document.getElementById('wecom-save')`)) === true)
  record('bridge exposes wecom.*', (await js(`Object.keys(window.dshShell.wecom ?? {}).sort().join(',')`)) === 'authorize,logout,status')
  for (let i = 0; i < 30 && (await el('wecom-pill')) === '检查中…'; i++) await wait(300)
  const pill = await el('wecom-pill')
  record('status pill resolved', pill === '已授权' || pill === '未授权', `${pill} · ${await el('wecom-meta')}`)
  record('secret input is masked', (await el('wecom-secret', 'type')) === 'password')

  const before = hash()
  await js(`document.getElementById('wecom-botid').value='aib_FAKEBOTID000'; document.getElementById('wecom-secret').value='FAKESECRET000'; document.getElementById('wecom-save').click(); true`)
  await wait(100)
  record('save shows progress + disables button', (await el('wecom-save', 'disabled')) === true, await el('wecom-status'))
  for (let i = 0; i < 120 && (await el('wecom-save', 'disabled')); i++) await wait(500)
  await wait(500)
  const msg = await el('wecom-status')
  record('bad credentials → clear error', /853000/.test(msg) && /现有授权未改动/.test(msg), msg)
  record('secret not echoed in UI', !msg.includes('FAKESECRET000'))
  record('stored credentials untouched', hash() === before)
  record('pill unchanged after failure', (await el('wecom-pill')) === pill)

  await js(`document.getElementById('wecom-pill').closest('section').scrollIntoView(); true`)
  await wait(300)
  const img = await win.webContents.capturePage()
  writeFileSync(join(process.cwd(), 'scripts', 'diagnostics', 'wecom-settings.png'), img.toPNG())
}

app.whenReady().then(async () => {
  try { await main() } catch (e) { record('selfcheck crashed', false, String(e?.stack ?? e)) }
  const failed = results.filter((x) => !x).length
  console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} passed`)
  app.exit(failed ? 1 : 0)
})
