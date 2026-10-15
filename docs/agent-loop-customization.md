# Agent loop customization

English | [中文](agent-loop-customization.zh.md)

> Question: can DSH's internal agent loop be modified? If not in the current
> version, would running from source help?
> Method: reading the type contracts and compiled output of `dsh-agent-loop` /
> `dsh-agent`, plus **actually booting the plugin tree to attempt a replacement**.
> Scripts: `scripts/audit-agent-loop.mjs`, `scripts/experiment-replace-loop.mjs`

---

## Conclusion

**Yes, and there are three routes at different granularities. The currently
installed version (`0.1.5-rc.2`) is sufficient — running from source is not required.**

| Route | Granularity | Needs source? | Measured |
|---|---|---|---|
| 1. Configuration | Tune the loop's parameters | No | Verified |
| 2. Lifecycle hooks | Intercept/rewrite at the loop's key points | No | Confirmed present |
| 3. Replace the whole `AgentFactory` | Swap out the entire loop driver | No (but must disable the built-in row) | **Verified feasible** |

**Running from source is not necessary** — it exists for changing DSH's own code,
and replacing the loop does not require that.

---

## Terminology

| Term | Meaning |
|---|---|
| agent loop | The main "call model → run tools → repeat" driver |
| turn / step | A conversation turn; a step is one model call plus its tool execution |
| factory | The object that creates and resumes agents |
| waterfall | A dispatch shape where listeners rewrite the value in turn |
| serial | A dispatch shape where listeners are notified in order, without rewriting |
| hook | An extension point a plugin can attach to |
| composition | The final plugin tree after every patch layer is applied |

---

## 1. The loop's extension points (measured inventory)

`dsh-agent-loop` drives extensions through three dispatch shapes. Every hook found
by measurement:

| Hook | Dispatch | Purpose |
|---|---|---|
| `agent/pre-step` | waterfall | Before each step; may rewrite or reject the step |
| `agent/request` | waterfall | While assembling the model request; may rewrite provider/model etc. |
| `agent/request-error` | waterfall | On request failure; returning `{ kind: 'retry' }` retries |
| `agent/turn-stopping` | serial | Notified when a turn stops; usable for a turn budget |

**Four hooks total** (3 waterfall + 1 serial, no bail).

This is the **official extension contract** — the loop's README states that
*"a policy that bounds runaway turns must cancel from an existing lifecycle
extension point such as `agent/turn-stopping`"*. In other words, upstream directs
you to these hooks for custom policy rather than editing the loop's source.

---

## 2. Replacing the whole loop: measured result

### The binding constraint

`AgentRegistry.setFactory` documents:

> **"Throws if a factory is already registered."**

And `dsh-agent-loop` calls `ctx.agents.setFactory(this)` in its own constructor
(confirmed in the compiled output). **So it cannot simply be overwritten — the
built-in row must be disabled first.**

### Measurement (`scripts/experiment-replace-loop.mjs`)

| Experiment | Action | Result |
|---|---|---|
| A | Register a second factory while the native loop is mounted | **Rejected**: `Error: an agent factory is already registered` |
| B | Disable the `agent-loop` row by patch, then register | **Accepted** |
| C | Whether a patch reaches the loop's config | **Yes**, `maxParallelToolCalls: 3` took effect |

```
verdict: replaceable: disabling the built-in row frees the factory slot for a custom driver
```

### How to replace it

`AgentFactory` is a **public interface** (defined in `dsh-agent`, not inside the
loop package). It needs only two methods:

```ts
interface AgentFactory {
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
}
```

`dsh-agent`'s documentation states this is deliberate:

> *"Kept on the `dsh-agent` interface so consumers program against `ctx.agents`
> without depending on the concrete `dsh-agent-loop` package."*

Wire it up like this:

```yaml
# desktop-profile/cordis.patch.yml
- id: agent-loop
  disabled: true          # frees the factory slot
- insert:
    - id: my-agent-loop
      name: './my-agent-loop.js'   # your custom implementation
```

### The cost: replacing the factory means rewriting the whole driver

The two methods look small, but the contract comments list heavy responsibilities:

- Constructing a private session, a concrete agent, and a scoped context
  (**one rollback-covered transaction**)
- Emitting `session/created` → `agent/created` → `agent/session-start` in order
- Persistence integration: `persistence.create(header)` / `persistence.open(id, 'write')`
- Managing write-handle ownership

The loop README's wording is *"Choose a custom Agent implementation only when the
standard 'call model, run tools, repeat' lifecycle is insufficient."* Upstream
itself frames it as a **last resort**, not a routine extension.

---

## 3. The configuration route (lightest)

The `agent-loop` row accepts patch config, measured to arrive:

```yaml
- id: agent-loop
  config:
    maxParallelToolCalls: 3      # parallel-safe tool calls per step; 1 is serial
    agents:
      - id: main
        provider: deepseek-official
        model: deepseek-v4-flash
        reasoningEffort: high
        cwd: /workspace
```

`maxParallelToolCalls` is also the whole `agent-loop` settings namespace, so a user
layer can adjust it **at runtime without a restart**.

---

## 4. Is running from source viable?

### What upstream says

`@deepseek-ai/dsh`'s README (lines 54–56):

> *"Production runs require built package and frontend artifacts. From the repository
> root, run `pnpm run build` separately, then use `pnpm dsh <args...>` to run the
> TypeScript entry and forward every argument; the source-execution reference owns
> the module-resolution contract."*

So: clone the repository → `pnpm run build` → `pnpm dsh <args>`.

### But it solves a different problem

Running from source lets you change **DSH's own code** — for example editing
`dsh-agent-loop/src/agent.ts` directly. The replacement route measured above does
**not** require changing DSH code; it is an extension seam upstream designed on purpose.

### A confirmed gap

The `reference/README.md#source-execution` that the README cites (the authoritative
source for the module-resolution contract) **is not included in the npm package**:

```
node_modules/@deepseek-ai/dsh/ contains only README.md and README.zh.md
the reference/ directory does not exist
```

So if you do intend to change DSH's own code, that contract document must be
obtained from the GitHub repository. The other decision records the READMEs cite
(`.agents/notes/implemented/**`) are likewise absent.

---

## 5. Which route to choose

| Your goal | Recommended route |
|---|---|
| Tune parallelism, model route, working directory | **Configuration** (one patch line) |
| Bound runaway turns, audit every request, retry policy | **Lifecycle hooks** (a plugin listening on `agent/*`) |
| A fundamentally different agent lifecycle (custom planner, multi-model orchestration) | **Replace `AgentFactory`** (disable the built-in row + implement it) |
| Change the loop's own internal implementation details | **Run from source** (the npm package ships compiled output only) |

The first three all work on the currently installed version. Only the fourth needs source.

---

## 6. Reproducing

```bash
npm run audit:agent-loop        # extension-point inventory
npm run experiment:replace-loop # replacement feasibility
```

---

## 7. Evidence strength

- **Confirmed by measurement**: the existence and dispatch shape of all four hooks;
  factory exclusivity (experiment A); replaceability after disabling (experiment B);
  patch config reaching the loop (experiment C)
- **Confirmed by reading type contracts**: where `AgentFactory` is defined and its
  two method signatures; `setFactory`'s exclusivity documentation;
  `AgentLoop implements AgentFactory`
- **Not verified**: whether a **complete** custom `AgentFactory` can actually drive
  a full conversation. This experiment only established that registration is
  accepted; no functional driver was written — that is substantial work, and only
  worth doing once you have decided to replace the loop.
- **Not in the npm package**: `reference/README.md` (the source-execution contract),
  `.agents/notes/implemented/**` (design decision records)
