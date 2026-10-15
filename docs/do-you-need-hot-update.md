# Landing follow-up requirements: is a hot update actually needed?

English | [中文](do-you-need-hot-update.zh.md)

> Question: to land follow-up requirements through the desktop client, is hot-update
> capability actually needed?
> **Direct answer: it depends on the phase. During development, no. After deployment, yes.**
> **No project code or structure is involved.**

---

## Direct answer

**Two phases, opposite conclusions:**

| Phase | Hot update needed? | Why |
|---|---|---|
| **Development** (you iterate in the source tree) | **No** | Change, restart the app — a few seconds |
| **Deployed** (after a user installs it) | **Yes** | Otherwise every change means reinstalling |

**So: if you are currently "developing this thing on the desktop client", the answer is — no hot update needed.**

Hot update is a **distribution** problem, not a **development** problem.

---

## 1. Why development does not need it

### Your iteration loop

```
edit preset YAML / edit patch
        |
restart the app (Ctrl+Q then relaunch, or just `npm start`)
        |
verify
```

**A restart takes a few seconds.** Against the implementation cost of a hot-update
mechanism, restarting wins overwhelmingly.

### Per change type

| What you change | How, during development | Hot update? |
|---|---|---|
| A preset's `agent.cordis.yml` | Edit, restart | No |
| `cordis.patch.yml` | Edit, restart | No |
| Shell code (`src/main/*.ts`) | `npm run build` + restart | No |
| Frontend bundles | Rebuild + restart | No |
| DSH itself | No need to change | — |

**In a source environment everything is writable and "restart applies it", so hot
update has no value there.**

### The only inconvenience is restarting

Several mitigations cost far less than building hot update:

| Measure | Effect |
|---|---|
| `npm start` | One command to build and launch |
| Session persistence | History survives a restart (measured: it lives in the data root) |
| Preset selection persistence | `agent-presets.default` remembers the choice |

**Note**: what a restart loses is the *in-flight streamed output*, not session history.

---

## 2. Why the deployed phase needs it

Once a user has installed the app, the `resources/` directory:

- **Was not created by them**, so editing it is unnatural
- **Is overwritten on upgrade** (see `self-maintenance.md`)
- Making them reinstall the app for every configuration change is unacceptable

**That is the real use case for hot update.**

Even then, **not every change needs it**:

| Change | How, once deployed | Hot update? |
|---|---|---|
| Preset content | Edit the data-area file | **No** (restart suffices) |
| Enable/disable a plugin | Edit the patch file | **No** (restart suffices) |
| Install a new plugin | `npm install` into the profile directory | **No** (restart suffices) |
| Not wanting to restart | — | **Yes** (only here does hot update earn its keep) |

**The key point**: hot update's value is *not restarting*, not *being able to change things*.

---

## 3. A correction to my earlier statement

My earlier claim that "the specialized agent needs no L2/L3/L4" was correct **within a
specific scope**:

| What that statement covered | |
|---|---|
| It said | **The specialized agent's composition and switching** (data plus one L1 row) |
| It said | **All four layer capabilities already ship with DSH; you need not implement them** |
| It did **not** say | that a kernel iteration needs no update to the deployed code |

**If the kernel (DSH itself) iterates**, that is a different matter entirely:

```
A new DSH version = new code on disk
                  = invisible to an already-running process (Node has imported and cached it)
                  = a restart is required
```

**So a kernel iteration genuinely does require an "update" — it is just that the update
is a restart, not a hot update.**

---

## 4. Three kinds of "update", distinguished

This is the most commonly conflated part:

| Phrase | What it actually means | What it needs |
|---|---|---|
| **No hot update needed** | The change is data; a restart applies it | A restart |
| **The deployed code must be updated** | Executable code changed | A restart (+ replacing files) |
| **A hot update is needed** | Code/data changed but a restart is unwanted | A hot-update mechanism |

**Your earlier "kernel iteration" question falls on the second row: the code must be
updated, but that update is a restart.**
**"Hot update" specifically means the third row — not restarting.**

---

## 5. Practical advice

### Now (development)

**Do not build hot update.** Just iterate:

```bash
npm start          # build + run
# make changes
Ctrl+Q, then npm start
```

**Rationale**: the implementation cost (§6) far exceeds the time it would save you
during development.

### Later (when distributing to users)

Consider it then, in priority order:

| Priority | Capability | Solves |
|---|---|---|
| 1 | Move the profile to the data area | Users can change things, and upgrades stop overwriting |
| 2 | A restart button | One click to restart after a change (far simpler than hot update) |
| 3 | A hot-update button | Saves one restart |

**Item 2 is the important one** — a "restart the app" button solves 90% of the problem
at near-zero cost (`app.relaunch()` is already available; measured).

**Hot update (item 3) is a nice-to-have, not a requirement.**

---

## 6. Why hot update should wait

| Component | Status | Effort |
|---|---|---|
| Host recomposes | Already exists | None |
| Renderer reload | Measured to work | Small |
| Change detection | Must be built | Medium |
| Idle-only triggering (to avoid interrupting a stream) | Must be designed | Medium |
| Failure rollback | Must be designed | Medium |
| User notification | Must be built | Small |

**And it only covers composition and client plugins** — kernel code changes (L3/L4)
still require a restart.

**In other words: hot update cannot solve kernel iteration, and kernel iteration is
rare anyway.**

---

## 7. The answer

> **To land follow-up requirements through the desktop client, is a hot update actually not needed?**

**During development: correct, it is not needed.**

**Once deployed: "being able to change things" is needed, but "hot update" is not
necessarily** — a restart button is enough; hot update only saves those few seconds.

**A kernel iteration is a separate matter**: it does require updating the deployed
code, and a restart is unavoidable (the Node module cache, plus L3 being blocked).
That update is not called a hot update — it is called "swap the version and restart".

---

## 8. Reproducing

```bash
npm run audit:kernel-iteration   # what each of the three change types requires
npm run audit:hot-update         # the L1-L4 capabilities themselves
```
