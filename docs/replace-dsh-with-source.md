# Should the project's DSH be replaced with the source version?

English | [中文](replace-dsh-with-source.zh.md)

> Decision question: the end state is "one button switching between general mode and
> project mode", where project mode may carry its own harness (including a modified agent
> loop). **Does that require replacing the npm DSH with a source checkout?**
> Method: measuring in-process composition switching, factory-slot release, and
> two-loop coexistence.
> Scripts: `scripts/audit-sequential-harness.mjs`, `scripts/audit-two-loops.mjs`
> **No project code or structure is involved.**

---

## Direct answer

**Yes — but not because "two harnesses must be source". It is because the packages you
need to change exceed "a few lines".**

| Your change | Source checkout required? |
|---|---|
| Adding your own plugin packages | **Not strictly** (plugins are out-of-tree by design) |
| Changing the agent loop's logic | **Yes** — you would be editing someone else's build output |
| Maintaining your own long-lived branch | **Yes** |

**In one sentence: a source checkout solves the *ownership of changes* problem, not the *can it run* problem.**

---

## 1. Correcting one misconception: two harnesses need no second process

You were concerned that "two harnesses" would be heavy. **Measurement says it is lighter than that.**

### Measured: after disposal, a different composition boots in the same process

```
firstBootDisposed:    true
secondBoot.succeeded: true
slotFreedByDispose:   true
```

**Disposing the plugin tree releases the `AgentFactory` slot, so a completely
different composition can boot in the same process.**

Switching modes is therefore:

```
general mode -> dispose the current composition -> boot the project composition -> reload the renderer
```

**One Electron process, one window, one data root throughout.**

### Why this resolves the `setFactory` conflict

The earlier audit found two loops cannot coexist (`setFactory` is exclusive). But
**that was the parallel case**. Your requirement is sequential, so the conflict never
arises — the first composition is disposed before the second boots.

**Conclusion: no second process, no second port, no parallel residency.**

---

## 2. So why is a source checkout still warranted?

Because the **nature of the change** is different.

### Three ways to change things compared

| | Edit `lib/*.js` (M1) | Source checkout |
|---|---|---|
| Try a few lines | Works | Works |
| Change the loop's core logic | Works, but painful | **Should** |
| Add or change interfaces | **Impractical** | Workable |
| Type checking | None | Full |
| Long-term maintenance | Hard to track | Rebaseable |
| Upstream updates | Manual comparison | Mergeable |
| Shipping inside the desktop app | Needs a patch script | Natural |

You explicitly said you may **change interfaces and add plugins**. **Changing
interfaces on build output is unmaintainable** — you lose type checking, refactoring,
and any ability to see an edit's knock-on effects.

### Upstream's own warning

The DSH README carries a prominent notice:

> **"THERE WILL BE COMPATIBILITY-BREAKING CHANGES."**

`0.1.5-rc.2` is a developer preview. **Without the source repository you cannot follow
upstream fixes.**

---

## 3. The real cost of a source checkout

The official flow (from `docs/development.md`):

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
```

### Prerequisites (confirmed by measurement/documentation)

| Requirement | Status |
|---|---|
| Node 22.19+ | Present (v24.21.0) |
| **Corepack + pnpm@11.7.0** | **Not installed** |
| Git 2.26+ | Present (2.55.0) |
| Disk/time | The first build takes a while |

### The build is not one step

What `pnpm run build` actually runs, per the documentation:

```
tsc -b tsconfig.host.json
tsdown --env.DSH_BUILD_FACE host
tsc -b tsconfig.client.json
tsdown --env.DSH_BUILD_FACE client
pnpm run build:web
```

Plus Typert code generation, lefthook git hooks, and vendor-directory constraint checks.

**This is not a simple project.** You said the environment is not a problem, so it is
feasible — but expect friction on the initial setup.

---

## 4. You do not need to source-ify everything

This is the key recommendation. **The source repository need not replace the npm
version** — both can coexist.

### Recommended arrangement

```
<workspace>\
├── deepseek-harness\        # the source repository (you edit here)
│   └── pnpm run build       # produces build artifacts
└── agent-desktop\           # the desktop project (this one)
    ├── package.json
    │   └── overrides: { "@deepseek-ai/dsh-agent-loop": "file:../deepseek-harness/packages/core/agent-loop" }
    └── src\main\host.ts     # resolves DSH through the override
```

**Benefits:**

| Effect | Why |
|---|---|
| You edit **source** | Full type checking and refactoring |
| Upstream stays mergeable | Your branch is based on the official repository |
| The desktop app barely changes | Just an `overrides` entry |
| You can take over incrementally | Override only the packages you change |

### The key: override only what you change

DSH has **240 `@deepseek-ai` packages** (measured). You do **not** need all of them in source.

```json
{
  "overrides": {
    "@deepseek-ai/dsh-agent-loop": "file:../deepseek-harness/packages/core/agent-loop"
  }
}
```

**The other 239 stay on the npm versions.** That cuts the risk and build burden sharply.

---

## 5. Two implementation paths for project mode

Given the measurements, you have two choices:

### Path A: preset only (no loop change)

If project mode needs only **a different tool set, persona, and policy**:

```
<dshHome>/.agent-presets/project/
├── preset.yml
└── agent.cordis.yml
```

**No source checkout needed.** This is the lightest path.

**But**: a preset is the agent plane and **cannot carry the loop** (the loop is
host-plane and publishes into the root realm).

### Path B: swap the loop (needs a source checkout)

If project mode needs **different agent-loop logic**:

```
1. In the source repository: fork dsh-agent-loop into dsh-agent-loop-project and modify it
2. Desktop profile patch:
   - id: agent-loop
     disabled: true          # stop the native loop
   - insert:
     - id: project-loop
       name: '@your-scope/dsh-agent-loop-project'
3. When switching modes: dispose, then re-boot the composition
```

**This needs a source checkout**, because you are changing someone else's package.

### How to decide

| What your project mode needs | Path |
|---|---|
| Different tools, prompts, policy | **A (preset)** |
| **Different loop logic** (e.g. a different turn/step mechanism) | **B (source checkout)** |

**You said you may "copy the native agent-loop logic and modify it"** — if that is the
case, **the answer is B: a source checkout is needed.**

---

## 6. Recommended sequence

| Stage | Do this | Why this order |
|---|---|---|
| 1 | **Build project mode as a preset first** | Validates the specialized-mode value at zero source cost |
| 2 | See whether the preset suffices | Many "need to change the loop" cases are configuration problems |
| 3 | Set up the source environment when it does not | By then you know exactly what must change |
| 4 | Override a single package (`agent-loop`) | Minimizes the change surface |
| 5 | Expand incrementally | As needed |

**Stage 1 matters most**: it validates the product shape (button switching, UI entry,
session isolation) **without any source environment**.

**If stage 1 suffices, you save the entire toolchain.**

---

## 7. The answer

> **Should the project's DSH be replaced with the source version?**

**It depends on whether project mode needs a different loop:**

| Scenario | Answer |
|---|---|
| Project mode needs different tools/prompts/policy only | **No** — use a preset |
| **Project mode needs different loop logic** | **Yes** — but override only the packages you change, not the whole tree |

**And: two harnesses need no second process.**
Measurement confirms a disposed tree frees the slot for a different composition, so
mode switching is lightweight.

**Recommendation: validate the product shape with a preset first, then decide on the
source environment.** You said the environment is not a problem, so this is a question
of **timing**, not **feasibility**.

---

## 8. Reproducing

```bash
npm run audit:sequential-harness   # in-process composition switching (the key measurement)
npm run audit:two-loops            # two-loop parallelism
npm run audit:dev-loop             # the three change mechanisms
```

---

## 9. Evidence strength

- **Confirmed by measurement**: disposal frees the `setFactory` slot and a different
  composition boots in the same process; `agent-loop` is a host-plane row not
  referenced by any preset; the capability list a preset can carry; DSH's 240-package
  dependency tree
- **Confirmed by reading official docs**: the source run flow (`git clone` +
  `pnpm install` + `pnpm run build`); the build's five stages; prerequisites
  (Node 22.19+ / Corepack pnpm@11.7.0); the "THERE WILL BE COMPATIBILITY-BREAKING
  CHANGES" notice
- **Not verified**: the **practical viability** of npm `overrides` pointing at a source
  build (requires an actual setup to confirm); the concrete shape of the project-mode loop
  modification (depends on your design)
