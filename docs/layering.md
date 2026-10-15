# Specialized agent and mode switching: which layer does this belong to?

English | [中文](layering.zh.md)

> Question: if the desktop client implements the specialized agent and mode
> switching, which layer does that work belong to?
> Method: measuring the plane ownership of the desktop composition, and auditing
> the shell's existing coupling.
> Script: `scripts/audit-layering.mjs`
> **No project code or structure is involved.**

---

## Conclusion (read this first)

**The bulk of this requirement does not land on any code layer — it lands on the data layer.**

| Component | Layer | Owner |
|---|---|---|
| The specialized agent's definition | **Data** — `<dshHome>/.agent-presets/` | DSH's discovery mechanism |
| Switching logic | **Host plane** — the `dsh-agent-presets` service | Ships with DSH |
| Switching UI | **Client plane** — `dsh-client-ui-agent-preset` | Ships with DSH |
| The desktop shell's role | **Shell plane** — seeding and entry points only | This project |

**So the correct architecture is: the shell does not *implement* a specialized agent,
it *provisions* one.**

The shell does two things:

1. **Seed** preset files on first run (exactly like the Chinese locale seeding already implemented)
2. **Provide entry points** (a menu item, a shortcut, possibly an "open preset folder" action)

**What it should not do**: keep a copy of the presets in the shell. That creates a
second source of truth immediately.

---

## 1. The three planes, measured

DSH's composition splits into three planes. Confusing them is the main way this kind
of work goes wrong.

### Measurements

```
planes: {
  totalEntries: 152,
  agentPlaneRows: 12,      <- what one preset owns
  hostPlaneRows: 140,      <- process-global singletons; a preset cannot own these
  presetRosterIsHostSide: true
}
```

### The agent plane (12 rows)

The rows defined by one preset's `agent.cordis.yml`. Measured sample:

```
tool-bash, tool-pwsh, tool-jobs, tool-fs, tool-fs-search,
agent-instructions, skill-filesystem, tool-skill,
command-goal, tool-todo, tool-goal, tool-web
```

These are things that need **one instance per session**: tools, skills, instructions.

### The host plane (140 rows)

**Process-global singletons** that a preset cannot own. Key rows measured:

```
llm, session, settings, credentials,
session-persistence-jsonl, sandbox, approval
```

The shipped `standard` preset's comments explain why:

> *"A service row here MUST sit inside a group carrying an `isolate` realm.
> Without one it publishes into the root realm, where it is process-global —
> another preset publishing the same name collides."*

Host-plane services are process-global, so **a second preset publishing the same name
collides**.

### The shell plane (this project)

The architectural discipline holds, as measured:

| File | Real DSH imports |
|---|---|
| `host.ts` | 2 dynamic imports |
| `paths.ts` | 0 |
| `locale.ts` | 0 |
| `settings.ts` | 0 |
| `tray.ts` | 0 |
| `window-state.ts` | 0 |
| `index.ts` | 0 |

`shellTouchesDshOnlyInHost: true` — the shell touches DSH only inside `host.ts`.

**That discipline is the basis for the answer**: the shell does not participate in the
composition at all, so a "specialized agent" naturally should not be implemented by it.

---

## 2. Why the specialized agent belongs to the data layer

### A preset is a file, not code

```
<dshHome>/.agent-presets/<id>/
├── preset.yml          # display name and description
├── agent.cordis.yml    # the agent-plane composition
└── skills/             # optional
```

DSH's discovery scans this directory and lists whatever it finds in the UI selector.

**Implications:**

| Property | Meaning |
|---|---|
| No compilation | Edit the YAML; it takes effect (after a restart) |
| No shell code changes | The shell need not know how many presets exist |
| Migrates with the data | Travels with settings and credentials |
| Revertible | Delete the directory |

### The shell's correct role: seeding

This is exactly isomorphic to the **Chinese locale seeding** already implemented:

| | Locale seeding | Preset seeding |
|---|---|---|
| Target | `<dshHome>/settings.yaml` | `<dshHome>/.agent-presets/` |
| Timing | First run (before DSH reads it) | First run (before DSH discovery) |
| Principle | **Never overwrite an existing one** | **Never overwrite an existing one** |
| Code location | `src/main/locale.ts` | A new `src/main/presets.ts` |

**The key principle is identical**: seeding is a first-run default, not a policy. Once
the user has edited it, the shell must respect that.

---

## 3. Where mode switching belongs

### The four stages of switching

| Stage | Plane | Implemented by | Shell work needed |
|---|---|---|---|
| Preset discovery | host | `dsh-agent-presets` discovery | None |
| Switching UI | client | `dsh-client-ui-agent-preset` | None |
| The switch action | host | The `dsh-agent-presets` service | None |
| Persisting the default | host | `agent-presets.default` in `settings.yaml` | May seed |

**The shell implements none of them.** The desktop client loads the same frontend
artifact, so the switcher is already there.

### Optional shell enhancements

The only reasonable enhancement is adding an *entry point* to the switch:

| Enhancement | Landing spot | Note |
|---|---|---|
| A "switch mode" menu item | shell | Focus the main window (no DOM manipulation) |
| A keyboard shortcut | shell | Same |
| "Open preset folder" | shell | Reuses the existing `openPath` IPC |
| "Reload presets" | shell | Reload the renderer (measured to work) |

All of these are **legitimate work inside the shell's own plane** — they do not touch
the composition, only provide access.

---

## 4. What explicitly should not be done

| Anti-pattern | Why it fails |
|---|---|
| Keeping a preset copy in the shell | Two sources of truth: DSH changes the file, the shell's copy goes stale |
| Having the shell write the preset selection into `settings.yaml` | That is DSH's settings namespace; the shell should treat it as read-only |
| Having the shell parse `agent.cordis.yml` | That is DSH's composition semantics; the shell should not understand it |
| Patching the `agent-presets` row from the shell | That changes the host-plane composition, beyond the shell's remit |
| Clicking DSH's switcher via DOM selectors | Fragile implicit coupling; breaks on any DSH update |

The last point already came up when building the "open settings" button: I
**deliberately did not** click DSH's settings item, because that would be a guessed
selector that breaks the moment DSH changes.

---

## 5. Additional findings from measurement

### Disabling the preset roster does not change the entry count

Measured: patching `disabled: true` onto the `agent-presets` row left the entry count
**unchanged** (`disablingRosterChangesHostComposition: false`).

**This is not a patch failure** — it means that row's `disabled` semantics differ from
an ordinary row's, or the row is not in the disableable set.

**Practical implication**: **do not try to disable the preset roster from the shell.**
It is host-plane infrastructure, and turning it off removes preset capability from
every session.

### `dsh plugin --profile desktop` is unavailable

The CLI reserves the `desktop` name (measured earlier). Preset creation therefore
cannot go through the CLI's authoring command — files must be written directly.

That further supports the data-layer framing: **the shell writing preset files directly
is legitimate**.

---

## 6. Concrete recommendation

### Directory layout (data layer)

```
<data root>\
├── settings.yaml
├── .credentials.yaml
└── .agent-presets\
    └── <specialized mode id>\
        ├── preset.yml
        ├── agent.cordis.yml
        └── skills\
```

### Shell code (shell plane)

Add `src/main/presets.ts`, deliberately symmetric with `locale.ts`:

```
- Check whether the target preset exists under <dshHome>/.agent-presets/
- If not -> copy it from the in-package template (the template stays read-only)
- If it does -> do nothing at all
```

Then add an "open preset folder" entry to the menu or settings window, reusing the
existing `openPath` IPC.

### The division of labour, stated plainly

| Work | Layer | Who does it |
|---|---|---|
| Design the specialized agent's composition | Data | You (editing `agent.cordis.yml`) |
| Seed it into the user data area | Shell | A new `presets.ts` in the shell |
| List it in the UI | Host | DSH ships it |
| Switch | Client + host | DSH ships it |
| Add an entry-point button | Shell | The shell |
| Make it migrate with the data | — | **Automatic** (same data root) |

---

## 7. The answer

> **Which layer does this belong to?**

**Mostly the data layer**, specifically `<dshHome>/.agent-presets/`.
The host and client planes are provided by DSH and need no development.
**The shell plane carries exactly two responsibilities: first-run seeding, and entry points.**

The benefit of this split: the bulk of the specialized agent (composition definition,
skills) is **pure data**, so it migrates with the data, is version-controllable,
diffable, and unaffected by DSH upgrades.

**The shell code is small** — roughly a 100-line `presets.ts` (isomorphic to
`locale.ts`) plus a menu item.

---

## 8. Reproducing

```bash
npm run audit:layering   # plane ownership and shell coupling
```

---

## 9. Evidence strength

- **Confirmed by measurement**: the agent plane's 12 rows vs the host plane's 140; the
  preset roster being host-side; the shell having zero DSH coupling outside `host.ts`;
  disabling the roster not changing the entry count
- **Confirmed by reading contracts**: the user preset directory location; the necessity
  of an `isolate` realm (host-plane services are process-global);
  `agent-presets.default` being a settings-namespace field
- **Not verified**: a complete implementation of the `presets.ts` seeding flow
  (testable only once written); the **exact reason** the entry count did not change when
  the roster was disabled (the behaviour was observed, but not traced to code)
