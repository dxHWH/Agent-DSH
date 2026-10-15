# Can the desktop client support "work on the desktop + iterate raw DSH"?

English | [中文](desktop-raw-dsh-iteration.zh.md)

> Final requirement: **use the desktop client day to day, while iterating on raw DSH
> (plugins, agent loop) in follow-up work.**
> Method: measuring the desktop's DSH resolution path, the code's editability, and
> three viable mechanisms.
> Script: `scripts/audit-dev-loop.mjs`
> **No project code or structure is involved.**

---

## Direct answer

**Yes. Three mechanisms, and the first works today.**

| Mechanism | How | Works today? | Best for |
|---|---|---|---|
| **M1 Edit in place** | Edit `node_modules/@deepseek-ai/*/lib/*.js` directly | **Yes** | Quick experiments |
| **M2 Override resolution** | npm `overrides` pointing at a local checkout | Needs config | Long-term development |
| **M3 Data-area DSH** | The desktop prefers a data-area DSH | **No** (small change needed) | Distribution |

**The key fact: the DSH the desktop loads lives inside your own project, and it is writable.**

```
<repo>\node_modules\@deepseek-ai\dsh          <- what the desktop loads
<repo>\node_modules\@deepseek-ai\dsh-agent-loop
```

**Not a read-only system install — an ordinary dependency in your project.** That is
what makes "iterate raw DSH" direct.

---

## 1. The enabling fact: the build output is readable and editable

Measured on `dsh-agent-loop/lib/index.js` (71,267 bytes):

| Check | Result |
|---|---|
| Has a `src/` tree | **No** |
| Has a source map | **No** |
| Named functions | **18** |
| Variable names preserved | **Yes** |
| Indentation preserved | **Yes** |

Every key business function is locatable:

```
executeToolCalls  (L512)
runGroup          (L530)
parseArguments    (L520)
appendToolCall    (L586)
ReactLoopAgent    (L64)
```

**Actual code from the file** (proving editability):

```js
async function executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext) {
	const agent = ctx.agents.requireInitiator();
	const { session } = agent;
	const planned = toolCalls.map((block) => ({
		block,
		exec: {
			callId: block.id,
			name: block.name,
			arguments: parseArguments(block.arguments),
			agent,
			signal
		}
	}));
	// ...
}
```

**This is standard bundler output (esbuild/tsdown style), not obfuscated code.**
Function names, parameter names, and control flow are all readable — editing it
directly is viable.

---

## 2. M1: edit in place (works today)

### How

```powershell
# edit directly
notepad "node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js"
# restart the desktop app
```

**No rebuild needed** (`lib/*.js` is what the runtime loads); edit and restart.

### Measured status

```
entryIsWritable: true
needsRebuild: false
```

### Benefits and costs

| | |
|---|---|
| Benefit | Zero configuration; edit and go |
| Benefit | No build step |
| **Cost** | **`npm install` overwrites it** |
| Cost | You are editing build output, not source |
| Cost | Hard to version-control (unless you keep the patch) |

### The measure this forces

Since `npm install` overwrites it, **changes must live in a replayable script**:

```
scripts/
└── patch-dsh/
    ├── 001-tool-execution-order.patch
    └── apply.mjs          # run from postinstall
```

Otherwise a single `npm install` loses everything.

---

## 3. M2: npm overrides (the long-term option)

### How

```json
{
  "overrides": {
    "@deepseek-ai/dsh-agent-loop": "file:./vendor/dsh-agent-loop"
  }
}
```

Vendor the packages you modify locally and point npm at them.

### Benefits

| | |
|---|---|
| Changes are **ordinary files**, version-controllable | |
| Not overwritten by `npm install` | |
| You can vendor incrementally (only the packages you touch) | |

### Cost

**DSH packages ship compiled output only**, so vendoring still yields compiled output.
For genuine source editing you would need to:

```
1. Clone the deepseek-harness repository from GitHub
2. pnpm run build   (the build step the official README documents)
3. Point overrides at the built output
```

**Only then do you get "edit TypeScript source -> build -> the desktop picks it up".**

### One caveat

`overrides` works per package name. To change `dsh-agent-loop` you only need to vendor
that one — but it is coupled to `dsh-agent` and `cordis`, so interface changes have
knock-on effects worth watching.

---

## 4. M3: data-area DSH (only needed for distribution)

### Status

Measured as **not currently supported**:

```
M3_dataAreaDsh: {
  supportedToday: false,
  changeNeeded: "add an env-var override in resolveInstallAnchor()"
}
```

`host.ts` calls `require.resolve('@deepseek-ai/dsh/package.json')` with no override hook.

### The change is small

Add an environment-variable override:

```ts
function resolveInstallAnchor(): string {
  const override = process.env.DSH_DESKTOP_ANCHOR
  if (override && existsSync(override)) return override
  return require.resolve('@deepseek-ai/dsh/package.json')
}
```

**But that is a distribution concern** (letting users swap DSH), not a need for your
current development scenario.

---

## 5. What the iteration loop looks like

### Changing the agent loop (M1)

```
edit node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js
        |
Ctrl+Q to quit
        |
npm start
        |
verify
```

**One cycle is roughly 10-20 seconds** (startup dominates).

### Changing plugins

Plugins are more flexible than the loop:

| Plugin type | How to iterate |
|---|---|
| Client plugin (UI) | Change the bundle, reload the renderer — **no app restart** |
| Host plugin (node side) | Change `lib/*.js`, restart the app |
| Preset composition | Change the YAML, restart (or reload the renderer) |

**The client-plugin path is fastest** — measured: the UI fully recovers after a
renderer reload.

### No hot update needed

As `do-you-need-hot-update.md` concludes: **during development a restart takes
seconds, so hot update is not worth building.**

---

## 6. One trade-off to face squarely

**You would be iterating on build output, not source.**

| | Possible now | Better, but costs setup |
|---|---|---|
| Changing code | Edit `lib/*.js` | Clone the source repo + build |
| Readability | Good (named functions survive) | Original TypeScript |
| Type checking | None | Full |
| Upstream upgrades | Manual comparison | Rebaseable |
| Setup cost | Zero | A build environment |

**My recommendation:**

| Phase | Use |
|---|---|
| Validating an idea (trying a few lines) | **M1** |
| Changes stabilising (tens of lines) | Save them as a patch script |
| Changes becoming a long-lived branch | **M2 + a built source checkout** |
| Distributing to users | M3 |

**Do not build the source toolchain up front** — use M1 first to find out whether the
idea is worth the investment, then decide whether to move to M2.

---

## 7. The answer

> **Can the desktop client support "use the desktop + iterate raw DSH"?**

**Yes, and you can start today.**

| Requirement | How it is met |
|---|---|
| Daily use on the desktop | Already built (native window + tray) |
| Iterating plugins | M1 edit `lib`, or change the preset composition |
| Iterating the agent loop | **M1: edit `dsh-agent-loop/lib/index.js`** |
| Persisting changes | A patch script / M2 overrides |
| No hot update needed | A restart suffices during development |

**The single limitation**: DSH is an npm-installed build output with no source. But the
copy in your project **is writable** and the code **is readable and editable**, so
iteration is viable.

**That limitation disappears with M2 plus a source checkout** — which is a decision for
when you commit to the long term.

---

## 8. Reproducing

```bash
npm run audit:dev-loop   # the three mechanisms and code editability
```

---

## 9. Evidence strength

- **Confirmed by measurement**: the desktop resolves DSH inside the project;
  `lib/index.js` is writable; 18 named functions and every key business function are
  locatable; no `src/` and no source map; `host.ts` has no anchor override hook
- **Confirmed by reading contracts**: the semantics of npm `overrides`; the official
  README's source build steps (`pnpm run build` + `pnpm dsh`)
- **Not verified**: that an M1 edit actually runs as intended in the desktop app
  (would require making a real change and observing it); the practical compatibility of
  M2 overrides with the DSH dependency tree
