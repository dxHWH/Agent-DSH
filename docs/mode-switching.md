# Mode switching: customizing agent behavior for a specific project

English | [中文](mode-switching.zh.md)

> Question: can a specialized agent behavior be built for a large project
> (**by changing the harness directly, not through skills/rules**), and switched
> between "general mode" and "specialized mode" with one click in both the DSH
> Web UI and the desktop client?
> Method: reading the `dsh-agent-presets` contract and measuring composition
> behavior. **No project contents are involved.**
> Script: `scripts/audit-mode-switching.mjs`

---

## Conclusion

**Yes — and DSH already ships the mechanism. The harness itself needs no modification.**

`dsh-agent-presets` is that mechanism. What it provides is not a soft constraint but
a complete definition of **which plugins mount for a session, which tools exist,
what persona applies, and what planning policy is injected**.

The UI-side switcher (`dsh-client-ui-agent-preset`) already exists too. **The
desktop client loads the same frontend artifact, so it automatically has the same switcher.**

| Requirement | DSH capability | Measured |
|---|---|---|
| Change the harness directly (not soft constraints) | A preset's `agent.cordis.yml` defines the full agent composition | Verified |
| General mode / specialized mode | Two presets | Verified: 152 vs 153 entries, independent |
| One-click switching | The preset selector already in the Web UI | Package mounted |
| Leave the DSH installation untouched | User presets live in `<dshHome>/.agent-presets` | Verified |
| Web UI and desktop behave identically | Same frontend artifact, same mechanism | Verified (152:152 parity) |

---

## 1. What a preset actually changes

This is the key distinction. A preset is **not** a prompt-level soft constraint — it
is a **composition definition**.

Taking the shipped `standard` preset (`presets/standard/agent.cordis.yml`) as an
example, it defines:

| Dimension | Content |
|---|---|
| persona | `dsh-persona` prefix/suffix (with `{{model}}` and `{{cwd}}` variables) |
| Instruction loading | `agent-instructions` plus `maxBytes` |
| Shell | `tool-pwsh` / `tool-bash` (platform-gated) |
| Filesystem | `tool-fs`, `tool-fs-search` |
| Background jobs | `tool-jobs` |
| Skills | `skill-filesystem`, `tool-skill` |
| Plan mode | `plan-mode`, **including a full injected system prompt** |
| Compaction | `compaction-basic`, `tool-result-pruner` (with thresholds) |
| Delegation | `tool-subagent`, `tool-subagent-fork`, `tool-workflow`, `tool-ralph` |
| Other | `tool-ask-user`, `tool-todo`, `tool-web`, `present` |

In other words: **switching presets changes what the agent can do, how it works, and
how it is described to itself.**

That satisfies the "not skills/rules" requirement — tools are **genuinely mounted
or genuinely absent**, the persona is **genuinely replaced**, and the planning
policy is **genuinely injected**.

---

## 2. Building a specialized mode

### Location

```
<dshHome>/.agent-presets/<preset-id>/
├── preset.yml          # display name and description (what the UI shows)
├── agent.cordis.yml    # * the full agent composition
└── skills/             # optional: skills exclusive to this preset
```

`preset.yml` is exactly the two lines the UI displays:

```yaml
name: 标准模式
description: 功能完整的编码 Agent，支持文件编辑、Shell、文件与检索、Skills、计划、目标、子代理和工作流。
order: 1
```

So a specialized mode can present itself as:

```yaml
name: 项目模式
description: An agent specialized for one project, with X/Y/Z tools and policies enabled.
order: 10
```

### Authoring is copy-only, by design

The `dsh-agent-presets` README states plainly that *"Authoring is copy-only"* —
creating a preset copies an existing preset's **entire directory** (composition,
display metadata, skill directories, assets), which you then edit. This is
intentional, not a missing feature.

Id rules: `[a-z0-9][a-z0-9-]*`, and it **must not collide** with an existing id
(a copy never overwrites).

### Upstream does exactly this itself

README line 179:

> *"the shipped set itself accepts the same cost — `cordis` and `code` each duplicate
> `standard`'s full assembly and then edit it — so the whole assembly stays readable in one file."*

The shipped `cordis` and `code` presets **are** "copy `standard`, then edit", and
upstream accepts the duplication because it keeps the whole assembly readable in a
single file. A specialized preset follows the identical path.

---

## 3. One-click switching: Web UI and desktop

### It already exists

`dsh-client-ui-agent-preset` is the preset selector component in the Web UI, and it
is mounted in the desktop client too (it is among the 45 client plugins in the 152
entries).

Because the desktop client loads the **same** `dsh-web-frontend/dist`, it
**automatically has the same switcher**. Nothing needs to be built separately for
the desktop — this is precisely what the earlier "152 : 152, zero difference"
measurement established.

### One rule worth knowing

README line 12:

> *"only an empty session may switch presets"*

**Only an empty session can switch presets.** A session already under way cannot
change mid-flight. That is sensible: a preset determines the agent's composition,
and swapping it mid-conversation would break the consistency of the session history.

Practical effect: switching modes means creating a new session with the target preset selected.

### Another switchable dimension that already exists

`dsh-permission-presets` is a **separate** preset system (this machine is configured
for `danger-full-access`), governing sandbox mode and approval policy. It is
orthogonal to the agent preset:

| Mechanism | Governs |
|---|---|
| `agent-presets` | What the agent can do: tools, persona, planning, delegation |
| `permission-presets` | How operations are constrained: sandbox mode, approval policy |

They compose: a specialized mode plus a stricter permission policy is a valid pairing.

---

## 4. The layer that goes even deeper

If a preset is not enough (for example, the agent loop's own behavior must change),
there is another layer: **the entire agent loop is replaceable** (see
`agent-loop-customization.md`). Measured:

- The native `agent-loop` row can be disabled by patch
- Once disabled, a custom `AgentFactory` can be registered
- Disabling first is required — `setFactory` is exclusive
  (`an agent factory is already registered`)

There are also four lifecycle hooks that can rewrite behavior without touching the
loop: `agent/pre-step`, `agent/request`, `agent/request-error`, `agent/turn-stopping`.

**These three layers form a spectrum from light to heavy:**

| Layer | What it changes | Strength |
|---|---|---|
| skill / rule | Prompt-level constraints | Soft |
| **agent preset** | **Tool set, persona, planning policy** | **Hard (recommended starting point)** |
| Custom AgentFactory | The entire agent loop | Hardest |

Since soft constraints are explicitly not wanted, **starting from a preset is the
right call** — it is the layer upstream designed for exactly this scenario.

---

## 5. Measured evidence

Result of `scripts/audit-mode-switching.mjs`:

```json
{
  "twoProfilesCoexist": true,
  "generalEntryCount": 152,
  "specializedEntryCount": 153,
  "generalLoopParallelism": "default",
  "specializedLoopParallelism": 2,
  "markerOnlyInSpecialized": true,
  "profilesAreIndependent": true,
  "nativeLoopDisabled": true,
  "customLoopPresent": true,
  "loopIsSwappablePerProfile": true,
  "agentPresetsShipped": ["cordis", "minimal", "ptc", "standard"],
  "agentPresetsSwitcherInUi": true
}
```

Three things are established:

1. **Two compositions coexist without interference** — different entry counts,
   different behavior parameters, and a marker row exclusive to the specialized layer
   that does not leak into the general layer
2. **The loop is replaceable wholesale** — native disabled plus a custom row
3. **The UI switcher already exists** — four shipped presets are selectable

---

## 6. What this means for the Web UI vs the desktop client

| | DSH Web UI | Desktop client |
|---|---|---|
| Mechanism | `dsh-agent-presets` | The same package |
| Switcher | `dsh-client-ui-agent-preset` | **Same frontend artifact, automatically present** |
| Preset storage | `<dshHome>/.agent-presets` | The same home (the desktop data root) |
| Extra development needed | None | **None** |
| Migration | — | Presets travel with the data root (verified) |

**The two surfaces have identical capability**, because the desktop client does not
build a separate UI — it puts the same UI in a native window.

---

## 7. Trade-offs worth deciding deliberately

### 1. Copy versus share

`standard`'s full assembly is 255 lines. Copying it for a specialized mode means:

- **Benefit**: the whole assembly is readable in one file, changes are direct, and it
  is decoupled from DSH upgrades
- **Cost**: upstream improvements to `standard` **will not flow into your copy**
  automatically

Upstream accepts this cost (`cordis`/`code` do exactly this). It should be accepted
knowingly.

### 2. One mode or several

Multiple presets are possible (for example: specialized-general, specialized-read-only
analysis, specialized-build). They can share most rows and differ only in key ones.
The UI orders them by `order`.

### 3. Whether a custom AgentFactory is needed

Only if "tool set + persona + planning policy" still cannot express the intent. It
requires implementing transactions, event ordering, and persistence integration
yourself — upstream frames it as a last resort.

**Recommendation: start with a preset and run it for a while.** If it turns out to be
insufficient, move down a layer — by then you will know exactly what is missing
rather than pre-emptively rewriting a driver.

---

## 8. Reproducing

```bash
npm run audit:mode-switching    # mode coexistence and switching capability
npm run audit:agent-loop        # agent loop extension-point inventory
npm run experiment:replace-loop # loop replacement feasibility
```

---

## 9. Evidence strength

- **Confirmed by measurement**: two compositions coexist independently; the loop can
  be disabled and replaced; a patch reaches the loop's config
- **Confirmed by reading contracts**: the user preset directory
  (`<dshHome>/.agent-presets`), copy-only authoring, the id rule, the empty-session
  switching rule, the mounted UI selector package, and upstream's own use of copy-based presets
- **Not verified**: whether a **fully functional** specialized preset can complete real
  work on the target project. That needs a real project environment and an actual
  composition design, and is worth investing in only once the direction is confirmed.
- **This document involves no** project contents, code, or structure.
