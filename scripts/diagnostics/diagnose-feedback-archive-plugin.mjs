/**
 * 诊断：boot 桌面 host，检查 tool-feedback-archive 插件是否被加载，
 * feedbackArchive Remote 是否注册，settings 命名空间 feedback-archive 是否注册。
 *
 * Run: npx electron scripts/diagnostics/diagnose-feedback-archive-plugin.mjs
 */
import { app } from 'electron'
import { join } from 'node:path'
import { createRequire } from 'node:module'

function finish(payload) {
  console.log('DIAG_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('DIAG_END')
  app.exit(0)
}

async function main() {
  const out = {}
  try {
    const require = createRequire(import.meta.url)
    const boot = await import('@deepseek-ai/dsh-app-boot')
    const { provideCmdline } = await import('@deepseek-ai/dsh-cmdline')
    const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')

    const desktopPatches = [
      {
        id: 'web-runtime',
        config: { openBrowser: false, printUrl: false, surfaceContext: true, trustedHosts: [] },
      },
      {
        insert: [{ id: 'tool-feedback-archive', name: '@deepseek-ai/dsh-tool-feedback-archive' }],
      },
      {
        id: 'ui-message-feedback',
        disabled: true,
      },
    ]

    const profileDir = join(app.getAppPath(), 'desktop-profile')
    const dshHome = join(app.getPath('userData'), 'DSH Desktop', 'dsh-home')
    process.env.DSH_HOME = dshHome

    const profile = boot.loadProfileDirectory('dsh-desktop', profileDir, installAnchor)
    const ctx = await boot.boot(
      'dsh-desktop',
      join(profile.dir, 'cordis.yml'),
      [...profile.layers.flatMap((l) => l.patches ?? []), ...(profile.patches ?? []), ...desktopPatches],
      (hostCtx) => {
        provideCmdline(hostCtx, { args: ['--no-open', '--port', '0'], exit: () => {} })
      },
    )

    // 检查 loader 里有没有 tool-feedback-archive 行 + ui-message-feedback 是否 disabled
    const loader = ctx.get('loader')
    let entries = []
    try {
      const list = loader?.entries?.()
      entries = list && typeof list[Symbol.iterator] === 'function' ? [...list] : []
    } catch {}
    out.loaderTotal = entries.length
    const archiveRow = entries.find((e) => String(e?.options?.name ?? '').includes('feedback-archive'))
    out.archiveRow = archiveRow
      ? { id: archiveRow.options?.id, name: archiveRow.options?.name, hasFiber: archiveRow.fiber !== undefined }
      : null
    const mfRow = entries.find((e) => String(e?.options?.id ?? '') === 'ui-message-feedback')
    out.uiMessageFeedback = mfRow
      ? { disabled: mfRow.options?.disabled === true, hasFiber: mfRow.fiber !== undefined }
      : null

    // 检查 feedbackArchive Remote 是否注册（通过 typert registry）
    try {
      const remotes = ctx.get('typertRemoteRegistry') ?? ctx.get('remotes')
      out.remoteRegistry = remotes ? typeof remotes.lookup === 'function' ? 'has lookup' : 'present' : 'absent'
    } catch {}

    // 检查 client graph 里是否有我的 client 插件 + api-remotes（提供 remote.messageFeedback）
    try {
      const modules = ctx.get('clientModules')
      if (modules && typeof modules.graph === 'function') {
        const graph = modules.graph()
        const entries = graph?.entries ?? []
        const mine = entries.filter((e) => String(e?.id ?? e?.name ?? '').includes('feedback-archive'))
        const remotes = entries.filter((e) => String(e?.id ?? e?.name ?? '').includes('api-remotes'))
        const mf = entries.filter((e) => String(e?.id ?? e?.name ?? '').includes('message-feedback'))
        out.clientGraph = {
          total: entries.length,
          hasMine: mine.length > 0,
          mine: mine.map((e) => ({ id: e?.id, name: e?.name })),
          hasApiRemotes: remotes.length > 0,
          messageFeedbackEntries: mf.map((e) => ({ id: e?.id, name: e?.name })),
        }
      } else {
        out.clientGraph = 'clientModules absent'
      }
    } catch (e) {
      out.clientGraphError = String(e)
    }

    // 检查 settings 命名空间
    try {
      const settings = ctx.get('settings')
      if (settings) {
        const desc = settings.describe?.({ redactSecrets: true }) ?? settings.describe?.()
        const nss = Array.isArray(desc) ? desc.map((d) => d.ns) : []
        out.settingsNamespaces = nss
        out.hasFeedbackArchiveNs = nss.includes('feedback-archive')
      } else {
        out.settings = 'absent'
      }
    } catch (e) {
      out.settingsError = String(e)
    }

    await ctx.fiber.dispose()
  } catch (error) {
    out.error = String(error)
    out.stack = error?.stack
  }
  finish(out)
}

app.whenReady().then(main).catch((e) => finish({ fatal: String(e) }))

