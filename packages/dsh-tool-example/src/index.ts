/**
 * Example domain-tool plugin — cordis plugin contract + tool registration.
 *
 * A deliberately small, business-free skeleton that demonstrates the patterns a
 * real domain tool needs (see `docs/domain-tool-patterns.md`):
 *
 * - deterministic tools with a uniform evidence result contract (`result.ts`);
 * - a "tool quick reference" system-prompt section so the model picks the
 *   right tool instead of grepping files itself;
 * - knowledge-base fallback on negative results (`kb_fallback.ts`);
 * - an explicit, user-triggered SQLite index with a scan fallback
 *   (`sqlite/`, `index_hint.ts`);
 * - long results written to a report and delivered with `present`.
 *
 * Mounted from an agent preset's `agent.cordis.yml`:
 *
 *   - id: tool-example
 *     name: '@deepseek-ai/dsh-tool-example'
 *     config:
 *       projectRoot: 'D:/path/to/project'
 *       reportDir: 'data/reports'
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { withKbFallback, KB_FALLBACK_MARKER } from './kb_fallback.js'
import { RESULT_OUTPUT, toOutput, type ToolResult } from './result.js'
import { runSearch } from './search.js'
import { DEFAULT_EXTENSIONS, type SourceOptions } from './sources.js'
import { ProjectIndex, INDEX_DIR_NAME, type IndexStatus, type IndexCoverage } from './sqlite/index.js'
import type { BuildProgressFn } from './sqlite/builder.js'

/** cordis plugin name (loader diagnostics). */
export const name = 'tool-example'

// Reused by the desktop shell (index status + rebuild with progress).
export { ProjectIndex, INDEX_DIR_NAME }
export type { IndexStatus, IndexCoverage, BuildProgressFn }

export const inject = ['tools', 'systemPrompt']

export const Config = z.object({
  projectRoot: z.string().description('Project root directory the tools read (any text-based project).'),
  reportDir: z.string().description('Where reports are written; relative paths resolve against the session workspace. Empty = no reports.'),
  kbQueryTool: z.string().default('mcp__knowledge__kb_query').description('Knowledge-base MCP tool used as fallback for negative results.'),
  extensions: z.array(z.string()).description('File extensions in scope (default: common text/code formats).'),
})

export function apply(ctx: any, config: any): void {
  const projectRoot: string = String(config?.projectRoot ?? '').trim()
  const reportDir: string | undefined = config?.reportDir ? String(config.reportDir) : undefined
  const kbTool: string = config?.kbQueryTool || 'mcp__knowledge__kb_query'
  const sourceOptions: SourceOptions = {
    extensions: Array.isArray(config?.extensions) && config.extensions.length > 0 ? config.extensions : DEFAULT_EXTENSIONS,
  }

  // Knowledge-base fallback applies only when the KB tool is visible to the
  // calling agent — never instruct the model to call a tool it does not have.
  const tools = ctx.tools
  const isKbAvailable = (exec: any): boolean => {
    try {
      const scope = exec?.agent
      return Boolean(scope ? tools.get(kbTool, scope) : tools.get(kbTool))
    } catch {
      return false
    }
  }
  const registerTool = (def: any) => tools.register(withKbFallback(def, kbTool, isKbAvailable))

  // A missing project binding must not break the preset: tools still register
  // and answer `needs_input` telling the user where to bind the directory.
  const unbound = (): ToolResult | null => {
    if (!projectRoot) {
      return { status: 'needs_input', answer: 'No project directory is bound. Ask the user to set it in Settings -> Project & Index, then restart.', evidence: [] }
    }
    if (!existsSync(projectRoot)) {
      return { status: 'execution_error', answer: `The bound project directory does not exist: ${projectRoot}. Ask the user to fix it in Settings -> Project & Index.`, evidence: [] }
    }
    return null
  }

  // One lazily created index handle per plugin instance.
  let index: ProjectIndex | null = null
  const getIndex = (): ProjectIndex => (index ??= new ProjectIndex(projectRoot, sourceOptions))

  if (ctx.systemPrompt) {
    ctx.systemPrompt.section({
      name: 'example:tool-quickref',
      order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') - 100,
      text: [
        '[Project tools quick reference]',
        'The bound project has deterministic query tools. Choose by intent:',
        '- "where is X / which files mention X / find X in the project" -> example_search',
        '- "is the project index up to date / how big is it" -> example_index_status',
        'Prefer these tools over glob/grep/read for questions about the bound project; they return evidence with file:line locators.',
        'When a result carries artifacts, call present to deliver the report file.',
        `When a result contains "${KB_FALLBACK_MARKER}", follow its instruction in the same turn.`,
      ].join('\n'),
    })
  }

  registerTool(
    defineTool({
      name: 'example_search',
      description:
        'Search the bound project for a keyword, identifier or phrase and return matching lines with file:line evidence. ' +
        'Use this instead of glob/grep/read when the question is about the bound project. ' +
        'Uses the prebuilt index when it is current; otherwise scans files directly (slower) and says so. ' +
        'Set write_report=true for a full Markdown report; when artifacts are returned, call present to deliver it.',
      parameters: {
        query: { type: 'string', required: true, description: 'What to look for (identifier, phrase, Chinese or English).' },
        limit: { type: 'integer', description: 'Maximum hits (default 50, max 500).' },
        write_report: { type: 'boolean', description: 'Write the full hit list to a Markdown report.' },
      },
      output: RESULT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args: any, exec: any) {
        const blocked = unbound()
        if (blocked) return toOutput(blocked) as any
        try {
          return toOutput(runSearch(args, {
            projectRoot,
            index: getIndex(),
            sourceOptions,
            reportDir,
            workspaceRoot: exec?.agent?.session?.header?.cwd,
          })) as any
        } catch (e) {
          return toOutput({ status: 'execution_error', answer: `Search failed: ${e instanceof Error ? e.message : String(e)}`, evidence: [] }) as any
        }
      },
      presentCall(args: any) {
        return { card: 'generic', title: `Search project: ${String(args?.query ?? '')}`, kind: 'read' }
      },
    }),
  )

  registerTool(
    defineTool({
      name: 'example_index_status',
      description: 'Report whether the bound project\'s query index is ready, stale, missing or building, with its size and build time. Never builds the index.',
      parameters: {},
      output: RESULT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute() {
        const blocked = unbound()
        if (blocked) return toOutput(blocked) as any
        const idx = getIndex()
        const st = idx.status()
        const cov = idx.coverage()
        const lines = [
          `Index state: ${st.state}${st.error_message ? ` (${st.error_message})` : ''}`,
          cov ? `Built: ${cov.built_at ?? 'unknown'} · ${cov.scope} · ${(cov.db_size_bytes / 1048576).toFixed(1)} MB` : 'No index has been built yet.',
        ]
        if (st.state !== 'ready') lines.push('To (re)build it, the user opens Settings -> Project & Index and clicks "Rebuild index".')
        const payload: Record<string, unknown> = { status: st }
        if (cov) payload.coverage = cov
        return toOutput({
          status: st.state === 'ready' ? 'trusted_hit' : 'partial',
          answer: lines.join('\n'),
          evidence: [{ kind: 'index', source: `${INDEX_DIR_NAME}/current.json`, verified: true }],
          payload,
        }) as any
      },
      presentCall() {
        return { card: 'generic', title: 'Project index status', kind: 'read' }
      },
    }),
  )
}
