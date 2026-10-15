/**
 * 点踩反馈归档插件 —— host 半（node 端）。
 *
 * 挂载方式（桌面 profile 的 buildDesktopPatches 里加）：
 *   insert: [{ id: 'tool-feedback-archive', name: '@deepseek-ai/dsh-tool-feedback-archive' }]
 *
 * 职责：
 * 1. 注册 settings 命名空间 `feedback-archive`
 *    （backend / localDir / wecomCliPath / rootFolderId / rootName）。
 * 2. 注册 HTTP 路由 `POST /api/feedback-archive`：读 { sessionId, messageId, note, category }，
 *    定位 session → 读事件流 → 转换 → 打包 ZIP（含 feedback.md）→ 保存到本地目录（默认）
 *    或经 wecom-cli 上传企业微信微盘（可选）→ 返回结果。
 *
 * 为什么用 HTTP 路由而非 Typert Remote：
 * - Remote 需要 typert 代码生成器产出 `typert.remote-client.js` 并注册进 `dsh-api-remotes`，
 *   这是 DSH monorepo 的构建步骤，桌面 shell 仓库无法完成。
 * - HTTP 路由是 `dsh-session-log-export` 已验证的成熟模式，client 端用 fetch 直调即可。
 */
import z from '@deepseek-ai/schemastery'
import { archiveFromEvents, DEFAULT_UPLOAD_CONFIG, type ArchiveConfig } from './archive.js'

export const name = 'tool-feedback-archive'

export const inject = ['sessions', 'sessionPersistence', 'settings', 'connection']

/** settings 命名空间名。 */
export const SETTINGS_NS = 'feedback-archive'

/** HTTP 路由路径。 */
export const ARCHIVE_ROUTE = '/api/feedback-archive'

/** settings 命名空间 schema（无凭证——wecom 后端走本机 wecom-cli auth，插件零凭证）。 */
const SettingsSchema = z.object({
  backend: z.union(['local', 'wecom'] as const).default('local').description('归档后端：local = 保存到本地目录（默认）；wecom = 上传企业微信微盘（需 wecom-cli 并授权机器人）'),
  localDir: z.string().default('').description('本地归档目录（空 = <数据根>/feedback-archive）'),
  wecomCliPath: z.string().default('').description('[wecom] wecom-cli 路径（空 = 自动探测）'),
  rootFolderId: z.string().default(DEFAULT_UPLOAD_CONFIG.rootFolderId ?? '').description('[wecom] 归档根目录 folder_id（空 = 按名查找/创建）'),
  rootName: z.string().default(DEFAULT_UPLOAD_CONFIG.rootName ?? '').description('[wecom] 归档根目录名'),
})

/** 把 settings + 默认值合并成 ArchiveConfig。 */
function archiveConfigFrom(settings: any): ArchiveConfig {
  return {
    backend: settings?.backend === 'wecom' ? 'wecom' : 'local',
    localDir: settings?.localDir || undefined,
    wecomCliPath: settings?.wecomCliPath || undefined,
    rootFolderId: settings?.rootFolderId || DEFAULT_UPLOAD_CONFIG.rootFolderId,
    rootName: settings?.rootName || DEFAULT_UPLOAD_CONFIG.rootName,
  }
}

/** 从 ctx 读取一个 session 的 header + 事件流（live 优先，cold 兜底）。 */
async function readSessionEvents(ctx: any, sessionId: string): Promise<{ header: any; events: any[] }> {
  const live = ctx.sessions?.get?.(sessionId)
  if (live) {
    return { header: live.header, events: live.snapshotEvents() }
  }
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    const { events } = await handle.read(0)
    return { header: handle.header, events }
  } finally {
    await handle.close()
  }
}

/** 统一 JSON 响应。 */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function apply(ctx: any): void {
  // 注册 settings 命名空间
  try {
    ctx.settings?.register?.(SETTINGS_NS, SettingsSchema)
  } catch (e) {
    ctx.logger?.warn?.(`tool-feedback-archive: settings register failed: ${String(e)}`)
  }

  // 注册 HTTP 路由：POST /api/feedback-archive
  ctx.effect(() => {
    const connection = Reflect.get(ctx, 'connection')
    if (!connection?.fetch?.register) {
      ctx.logger?.warn?.('tool-feedback-archive: connection.fetch.register unavailable; archive route not mounted')
      return
    }
    const dispose = connection.fetch.register({
      path: ARCHIVE_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        let body: any
        try {
          body = await request.json()
        } catch {
          return jsonResponse({ ok: false, error: 'invalid JSON body' }, 400)
        }
        const { sessionId, messageId, note, category } = body ?? {}
        if (!sessionId || !messageId) {
          return jsonResponse({ ok: false, error: '缺少 sessionId 或 messageId' }, 400)
        }

        // 读配置
        let settings: any
        try {
          settings = ctx.settings?.get?.(SETTINGS_NS)
        } catch {
          settings = undefined
        }
        const cfg = archiveConfigFrom(settings)

        // 读事件流
        let header: any
        let events: any[]
        try {
          const r = await readSessionEvents(ctx, sessionId)
          header = r.header
          events = r.events
        } catch (e) {
          return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
        }

        // 转换 + 打包 + 保存/上传（feedback：note + category 会生成 feedback.md 进 ZIP）
        const result = await archiveFromEvents(header, events, messageId, cfg, {
          note,
          category,
        })
        return jsonResponse(result, result.ok ? 200 : 500)
      },
    })
    return () => dispose()
  }, 'tool-feedback-archive: HTTP route')
}

export { SettingsSchema }
