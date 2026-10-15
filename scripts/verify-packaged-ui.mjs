/**
 * End-to-end check of the packaged UI: workspace selection reaches a composer,
 * and the preset selector offers the project mode.
 *
 * The unit self-check proves the repair logic; this proves the shipped app
 * actually gets a user past the workspace screen, which is the symptom the
 * dangling preset produced.
 *
 * Usage: node scripts/verify-packaged-ui.mjs [port]
 */
const port = process.argv[2] ?? '9228'

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  return ws
}

function makeSend(ws) {
  let id = 0
  return async (method, params) => {
    const myId = ++id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 25000)
      const handler = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.id === myId) {
          clearTimeout(timer)
          ws.removeEventListener('message', handler)
          resolve(msg)
        }
      }
      ws.addEventListener('message', handler)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const ws = await connect()
  const send = makeSend(ws)
  const warnings = []
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data)
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      const text = m.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' ')
      if (text.includes('Security Warning')) return
      warnings.push(text.slice(0, 200))
    }
  })
  await send('Runtime.enable', {})

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true })
    if (r.result?.exceptionDetails) return undefined
    return r.result?.result?.value
  }

  const checks = []
  const check = (name, ok, detail) => {
    checks.push({ name, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` [${detail}]` : ''}`)
  }

  const body = (await evaluate(`document.body.innerText`)) ?? ''
  const hasComposer = await evaluate(`!!document.querySelector('textarea,[contenteditable=true]')`)

  check('UI mounted', body.length > 0, `${body.length} chars`)
  check('a workspace is active (composer reachable)', hasComposer === true)
  check('not stuck on the workspace screen', !body.includes('选择一个工作区开始'))

  // The preset chip opens the mode list.
  const chip = await evaluate(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>/模式$/.test((x.innerText||'').trim())); if(!b) return null; b.click(); return b.innerText.trim() })()`,
  )
  check('agent-preset chip present', typeof chip === 'string', chip ?? 'none')
  await wait(2000)

  const menu = (await evaluate(`document.body.innerText`)) ?? ''
  check('项目模式 is offered', menu.includes('项目模式'))

  if (warnings.length > 0) {
    console.log('\nconsole warnings:')
    for (const w of warnings) console.log(`  ${w}`)
  }

  ws.close()
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
  if (failed.length > 0) process.exit(1)
}

main().catch((error) => {
  console.error('verify failed:', error.message)
  process.exit(1)
})
