# Which L1–L4 layer does specialized-agent work land on?

English | [中文](agent-layer-mapping.zh.md)

> Question: implementing a specialized agent and mode switching from the desktop
> client — which of **L1–L4** does it fall on?
> Method: part-by-part measured mapping (L1–L4 defined in `hot-update.md`).
> Script: `scripts/audit-agent-layer-mapping.mjs`
> **No project code or structure is involved.**

---

## The direct answer

**It is part-by-part — different parts land on different layers:**

| Part of the work | Layer | Development needed? |
|---|---|---|
| The specialized agent's definition (preset files) | **Not in L1–L4** — it is data | Yes (you write the YAML) |
| The preset roster row (`agent-presets`) | **L1** (composition row) — but ships mounted | **No** |
| The switching UI (`ui-agent-preset`) | **L2** (client plugin) — but ships mounted | **No** |
| The switching logic service | **L3** (host plugin) — ships mounted | **No** |
| Changing the agent loop itself | **L4** (DSH version upgrade) | Only if required |

**In one sentence: the bulk of the specialized-agent work is *data*, at most
accompanied by one L1 composition row. It needs no L2, L3, or L4.**

---

## Why the bulk is not in L1–L4 at all

L1–L4 is a **hot-update taxonomy** — it describes *how a change takes effect*. But
the preset's substance is not a change at all; it is **data the host reads at startup**.

### Measurement

```
partA_presetFiles: {
  location: "<dshHome>/.agent-presets",
  isCompositionRow: false,
  isData: true,
  layer: "none of L1-L4 — this is data, read by dsh-agent-presets discovery"
}
```

**Adding a preset adds no profile row and swaps no plugin bundle.** It simply gives
discovery one more directory to find.

That is why asking "which layer" against L1–L4 yields no tidy answer —
**the substance of this requirement does not sit on that axis.**

---

## Part-by-part mapping (measured)

### L1 — composition row

The `agent-presets` roster row **is itself L1** (a host-plane composition row):

```
partB_rosterRow: {
  present: true,
  id: "agent-presets",
  name: "@deepseek-ai/dsh-agent-presets",
  disabled: false
}
```

**But it already ships mounted; your work does not touch it.**

If it ever did need changing (for example, configuring a preset root), that would be
an L1 change — edit the patch. No hot update required.

### L2 — client plugin

The switching UI is a client plugin:

```
partC_switcherUi: {
  present: true,
  id: "ui-agent-preset",
  isClientPlugin: true
}
```

**Also ships mounted.** Only if you needed to *change that picker's appearance or
behavior* would this become L2 (a client bundle swap).

**The current requirement does not.**

### L3 — host plugin

The switching logic is provided by a host service:

```
partD_switchingService: {
  present: true,
  id: "agent-presets",
  isHostService: true,
  needToReplace: false
}
```

**Replacing it would be L3** — and L3 is unavailable in Electron (it needs
`--expose-internals`).

**The current requirement does not replace it.**

### L4 — DSH version

Only if the **agent loop itself** must change does this become L4.

**The current requirement does not** — a preset changes the composition (tool set,
persona, policy), not the loop's implementation.

---

## The operationally meaningful mapping

This is the one part with practical consequence — **when a change takes effect**:

```
partE_operationalLayer: {
  toAddAPreset: "needs a host restart or renderer reload before discovery sees it",
  reason: "discovery reads the roster when the plugin starts, not per keystroke"
}
```

| Action | How it takes effect | Layer |
|---|---|---|
| Add a new preset | Requires a host restart / renderer reload | Adjacent to L1 (recomposition) |
| Edit an existing preset's composition | The next session picks it up | No hot update needed |
| Add an **already-installed** plugin to a preset | That preset's composition rows change | **L1** |
| Add a **not-yet-installed** plugin to a preset | The package must be installed first | Adjacent to L4 (dependency change) |
| Change the loop's implementation | Swap the DSH version | **L4** |

---

## Summary table

| Need | Layer | Status |
|---|---|---|
| Define a specialized agent | **Data** | You write the files |
| Make it appear in the UI | L1 row (roster) | Already mounted |
| Switching UI | L2 plugin | Already mounted |
| Switching logic | L3 service | Already mounted |
| Change the loop | L4 | Not required |

**Three of the four layers (the L1 roster, the L2 UI, the L3 service) all ship mounted
with DSH. You neither implement them nor hot-update them.**

---

## Reproducing

```bash
npm run audit:agent-layer-mapping   # part-by-part layer mapping
npm run audit:hot-update            # the L1-L4 capabilities themselves
```
