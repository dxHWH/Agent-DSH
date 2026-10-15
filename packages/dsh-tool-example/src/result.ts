/**
 * The result contract every tool in this plugin returns.
 *
 * A deterministic tool is only useful to a model when its answer says how far it
 * can be trusted. Every result therefore carries:
 *
 * - `status`   — a closed vocabulary the system prompt and the knowledge-base
 *                fallback can branch on without parsing prose;
 * - `answer`   — the compact, model-facing text (keep it short; long material
 *                goes to a report file, see `report_writer.ts`);
 * - `evidence` — where each claim came from (`source` + optional `locator`),
 *                and whether it was verified against the source;
 * - `artifacts`— files written for the user (the model must `present` them);
 * - `payload`  — structured data for programmatic consumers.
 */

export type ResultStatus =
  /** Found and verified against the source. */
  | 'trusted_hit'
  /** Something was found, but not everything asked for; or "not found". */
  | 'partial'
  /** Ambiguous or missing input — ask the user (candidates in payload). */
  | 'needs_input'
  /** The question is outside what this tool can answer locally. */
  | 'capability_gap'
  /** The tool failed (bad arguments, unreadable source…). */
  | 'execution_error'

export const RESULT_STATUSES: readonly ResultStatus[] = [
  'trusted_hit',
  'partial',
  'needs_input',
  'capability_gap',
  'execution_error',
]

export interface Evidence {
  /** Kind of source, e.g. `file`, `index`. */
  kind: string
  /** Project-relative POSIX path (never an absolute machine path). */
  source: string
  /** Finer position inside the source, e.g. `L42`. */
  locator?: string
  /** The claim this evidence supports. */
  claim?: string
  verified: boolean
}

export interface ArtifactRef {
  /** Path relative to the session workspace (what `present` expects). */
  path: string
  media_type: string
  label: string
}

export interface ToolResult {
  status: ResultStatus
  answer: string
  evidence: Evidence[]
  artifacts?: ArtifactRef[]
  payload?: Record<string, unknown>
}

/**
 * Normalize a result for the tool runtime.
 *
 * DSH validates tool output losslessly: a key whose value is `undefined` does
 * not survive JSON and fails validation. Optional fields are therefore only
 * assigned when present — never spread as `payload: undefined`.
 */
export function toOutput(r: ToolResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    status: r.status,
    answer: r.answer,
    evidence: r.evidence,
    artifacts: r.artifacts ?? [],
  }
  if (r.payload !== undefined) out.payload = r.payload
  return out
}

/** The output schema shared by every tool (DSH `defineTool` schema dialect). */
export const RESULT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: [...RESULT_STATUSES] },
    answer: { type: 'string', required: true },
    evidence: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          source: { type: 'string', required: true },
          locator: { type: 'string' },
          claim: { type: 'string' },
          verified: { type: 'boolean', required: true },
        },
      },
    },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          media_type: { type: 'string', required: true },
          label: { type: 'string', required: true },
        },
      },
    },
    payload: { type: 'object', additionalProperties: true, properties: {} },
  },
} as const

/** Shared `output` block: schema + rendering + presentation metadata. */
export const RESULT_OUTPUT = {
  schema: RESULT_OUTPUT_SCHEMA,
  render: (_args: any, value: any) => [{ type: 'text' as const, text: String(value.answer ?? '') }],
  presentationMeta: (_args: any, value: any) => ({
    status: value.status,
    evidence: value.evidence,
    artifacts: value.artifacts,
  }),
}
