# Specialized agent: requirements and feasibility summary

English | [中文](specialized-agent-summary.zh.md)

> Purpose: align the requirement "build a specialized agent for a specific large
> project, switchable with one click between general and specialized modes" with
> what DSH actually provides, as a decision document.
> Basis: measured evidence from this session (reproducible via scripts) and a full
> read of the official contracts.
> **No project code or structure is involved in this document.**

---

## 1. The requirements

| # | Requirement | Nature |
|---|---|---|
| R1 | Build specialized agent behavior for a specific project | Capability customization |
| R2 | **Change the harness directly, not through skills/rules** | Hard constraint |
| R3 | One-click switching between "general mode" and "specialized mode" | Usability |
| R4 | Must work in both the DSH Web UI and the desktop client | Coverage |
| R5 | Must not break the ability to upgrade DSH | Maintainability |

---

## 2. Conclusion

**All five requirements can be met on the currently installed version
(`0.1.5-rc.2`), without modifying DSH itself and without running from source.**

The core judgement: **"change the harness" in R2 has two possible meanings, and DSH
happens to have designed both as extension points.**

| Interpretation | DSH capability | Needs DSH source changes? |
|---|---|---|
| Change **behavior** (tools, persona, policy) | `agent-presets` | **No** |
| Change **mechanism** (the agent loop itself) | Replace `AgentFactory` + 4 lifecycle hooks | **No** (but substantial work) |
| Change **DSH's own code** | Run from source | Yes |

**The recommendation is to land on the first layer.** It is the mechanism upstream
designed for exactly this scenario, and it fully satisfies R2's "hard constraint".

---

## 3. Why `agent-presets` counts as hard, not soft

This is the crux of aligning the requirement with the capability, so it is worth
stating precisely.

A skill or rule is a **prompt-level** constraint — the model may choose not to follow
it, and the tools remain visible and usable.

An `agent-presets` preset is a **composition-level** definition. A preset's
`agent.cordis.yml` decides:

| Dimension | Form | Hardness |
|---|---|---|
| Tool set | Plugins are **genuinely mounted or genuinely absent** | Hard |
| Persona | The system prompt is **genuinely replaced** | Hard |
| Plan mode | The policy text is **genuinely injected** | Hard |
| Compaction | Thresholds **genuinely apply** | Hard |
| Delegation | Subagents/workflows **genuinely enabled or disabled** | Hard |
| Instruction loading | File and byte cap **genuinely configured** | Hard |

The shipped `standard` preset demonstrates this: it defines a complete agent across
ten capability groups — persona, shell, filesystem, background jobs, skills, planning,
compaction, and delegation.

**Switching presets changes what the agent *is*.** That satisfies R2.

---

## 4. Requirements against capabilities

| Requirement | DSH capability | Measured evidence | Status |
|---|---|---|---|
| R1 Specialized behavior | A preset defines the full composition | The `standard` preset spans 10 capability groups | Met |
| R2 Hard constraints | Tools genuinely mounted/absent | Composition comparison: 152 vs 153 entries | Met |
| R3 One-click switching | The `dsh-client-ui-agent-preset` selector | Package mounted; visible in the UI | Met |
| R4 Both surfaces | The desktop client loads the same frontend artifact | 152 : 152, zero difference | Met |
| R5 Upgrade-safe | Presets live in `<dshHome>/.agent-presets` | Measured: outside the DSH installation | Met |

### Two additional orthogonal dimensions

| Dimension | Mechanism | Governs |
|---|---|---|
| Permissions | `permission-presets` | Sandbox mode, approval policy |
| Composition detail | Patch `insert` / `disable` | Adding, overriding, disabling rows |

All three compose together.

---

## 5. How modes work

### Layout

```
<dshHome>/.agent-presets/
├── general/                 # general mode (or just use the built-in standard)
│   ├── preset.yml
│   └── agent.cordis.yml
└── specialized/             # specialized mode
    ├── preset.yml           # name / description / order
    ├── agent.cordis.yml     # a copied full assembly, edited as needed
    └── skills/              # optional: skills exclusive to this mode
```

### Display and switching

`preset.yml` is exactly the two lines the UI shows:

```yaml
name: 专用模式
description: An agent specialized for <project>, with X/Y/Z enabled.
order: 10
```

The selector orders by `order`; both modes appear side by side and switch on click.

### One key rule

**Only an empty session can switch presets.**

This is design, not a defect: a preset determines the agent's composition, and
swapping it mid-conversation would break the consistency of session history.

**Practical interaction**: switching modes means creating a new session with the
target preset selected.

### Authoring is copy-only, by decree

`dsh-agent-presets` requires *"Authoring is copy-only"* — copy an existing preset's
entire directory, then edit it. The id must match `[a-z0-9][a-z0-9-]*` and must not
collide with an existing one.

Upstream does this itself: the shipped `cordis` and `code` presets are
"copy `standard`, then edit".

---

## 6. Key trade-offs

### Trade-off 1: upstream drift from copying (requires active management)

Copying `standard` (255 lines) means **upstream improvements to `standard` will not
flow into your copy automatically**.

| | |
|---|---|
| Upstream stance | Accepted. `cordis`/`code` do this, justified by keeping the whole assembly readable in one file |
| Risk | Upstream fixes and improvements never reach your specialized mode |
| Recommendation | Periodically diff upstream `standard` against your copy and decide deliberately what to absorb |

This is the **only ongoing maintenance cost**.

### Trade-off 2: one mode or several

Multiple specialized presets are possible (e.g. specialized-full, specialized-read-only
analysis, specialized-build), sharing most rows and differing only in key ones. The UI
orders them by `order`.

**Recommendation**: start with one, run it for a while, and split only when a real
need appears.

### Trade-off 3: whether deeper customization is needed

Only when "tool set + persona + policy" still cannot express the intent:

| Deeper layer | Capability | Cost |
|---|---|---|
| Lifecycle hooks | 4 hooks can rewrite behavior | A plugin; moderate |
| Replace `AgentFactory` | Swap the entire agent loop | Must implement transactions, event ordering, persistence integration — **upstream frames it as a last resort** |

**Recommended path: preset → hooks → factory replacement.** Go down one layer at a
time, only when the current layer proves insufficient — rather than pre-emptively
rewriting a driver.

---

## 7. Measured capability boundaries

Everything below was measured in this session (reproducible via scripts), not inferred:

| Capability | Measured result |
|---|---|
| Two compositions coexist without interference | 152 vs 153 entries; loop param `default` vs `2`; the specialized-only row did not leak |
| A patch reaches the loop's config | `maxParallelToolCalls: 3` took effect |
| The whole agent loop is replaceable | After disabling the native row, a custom factory **registered successfully** |
| Factory exclusivity | Registering a second while native is mounted → `an agent factory is already registered` |
| Available lifecycle hooks | 4: `agent/pre-step`, `agent/request`, `agent/request-error`, `agent/turn-stopping` |
| Web and desktop parity | 152 : 152, zero difference |
| The preset selector exists | `dsh-client-ui-agent-preset` is mounted |

### What remains unverified

**Whether a fully functional specialized preset can complete real work on the target
project.**

That needs a real project environment, an actual composition design, and iterative
tuning. Per the stated constraint, this session did not touch project contents, so
that layer awaits confirmation of the direction.

---

## 8. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Upstream drift** (trade-off 1) | The specialized mode falls behind upstream improvements | Periodic diffs; or keep the shareable portion minimal |
| DSH is a release candidate | Seams may move | Pin the version; a preset is **configuration, not code**, so an upgrade hurts far less than a custom driver would |
| Poor composition design | The specialized mode performs worse than general | Start from a copy of `standard`, change incrementally, keep it revertible |
| Too many modes | UI clutter, scattered maintenance | Start with one; split on demand |
| Mistaking it for a mid-session switch | Operational confusion | Make it explicit: switching means creating a new session |

**Note**: the greatest benefit of the preset route is that it **is not code**. Even
if a DSH upgrade moves a seam, your specialized mode is still just YAML — far cheaper
to migrate than a custom driver.

---

## 9. Recommended sequence

| Stage | Content | Output |
|---|---|---|
| 1 | Copy `standard` as the specialized mode; change only `preset.yml`'s name and description; verify it appears in the UI | A switchable shell |
| 2 | Adjust `agent.cordis.yml` item by item: persona first, then tool set, then policy | Specialized behavior takes shape |
| 3 | Iterate on real tasks and identify gaps | A tuned composition |
| 4 | If the composition still cannot express the intent, evaluate lifecycle hooks | Go deeper only if needed |
| 5 | Establish a periodic diff against upstream `standard` | Drift resistance |

Stage 1 is **low-risk validation** — changing only the display name confirms the whole
chain (file location, UI listing, switching) before investing in stage 2's composition design.

---

## 10. Reproducible verification

```bash
npm run audit:mode-switching     # mode coexistence and switching
npm run audit:agent-loop         # agent loop extension-point inventory
npm run experiment:replace-loop  # loop replacement feasibility
npm run audit:capabilities       # Web/desktop parity
```

---

## 11. Related documents

- `docs/mode-switching.md` — the full mode-switching assessment
- `docs/agent-loop-customization.md` — agent loop customization and the three routes
- `docs/capability-audit.md` — measured feature parity
- `docs/USAGE.md` — desktop usage guide

---

## 12. Evidence strength

- **Confirmed by measurement**: every item in §7
- **Confirmed by reading official contracts**: preset location, copy-only authoring,
  the id rule, the empty-session switching rule, the UI selector package, and
  upstream's own use of copy-based presets
- **Not verified**: the real-world effectiveness of a fully functional specialized
  preset on the target project
- **This document contains no** project code, structure, or contents
