/**
 * electron-builder configuration.
 *
 * ## The asar problem
 *
 * DSH spawns child processes — the pwsh/bash tools, worker threads, and
 * `node-pty`'s terminal helper — and native `.node`/`.exe`/`.dll` files cannot
 * be loaded from inside an asar archive. Anything a child process must execute
 * has to be unpacked to a real path on disk.
 *
 * `asarUnpack` below therefore covers three distinct kinds of payload:
 *
 *  1. **Native addons** (`*.node`) and their sidecar binaries (`*.dll`, `*.exe`)
 *     — `node-pty`, `koffi`.
 *  2. **Non-JavaScript assets** (`*.wasm`, `*.png`) that some packages read via
 *     `fs` rather than `require`.
 *  3. **The embedded DSH installation** — it is a full npm dependency tree that
 *     resolves its own package files at runtime through the filesystem, so it
 *     must live outside the archive.
 *
 * The profile directory is copied as an extra resource for the same reason: DSH
 * reads `package.json` and `cordis.patch.yml` from it with `fs`.
 */
/**
 * Third-party runtime deps of the local tool package @deepseek-ai/dsh-tool-example
 * (direct + transitive), hoisted in root node_modules. The example has none (it
 * uses only node built-ins such as node:sqlite). When a domain tool adds an npm
 * dependency (e.g. a spreadsheet or XML parser), list it AND all its transitive
 * deps here — they are asar-unpacked for the index-rebuild worker and copied under
 * the profile, otherwise the packaged build fails with "Cannot find module".
 */
const EXAMPLE_RUNTIME_DEPS = []

module.exports = {
  appId: 'com.agent.desktop',
  productName: 'Agent Desktop',
  executableName: 'Agent Desktop',
  copyright: 'Agent Desktop',

  // Only Windows is targeted; the shell's tray, path, and picker behavior are
  // written for it.
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon.ico',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Agent Desktop',
  },

  directories: {
    output: 'release',
    buildResources: 'assets',
  },

  /*
   * Electron fuses.
   *
   * `onlyLoadAppFromAsar` defaults to enabled, which blocks loading application
   * code from outside the asar archive. DSH is a 240-package dependency tree
   * that is deliberately unpacked (see `asarUnpack` below) because it reads its
   * own files at runtime — so the two settings pull against each other.
   *
   * Disabling this fuse is the narrowest change that removes that tension while
   * leaving the other hardening fuses at their defaults.
   */
  electronFuses: {
    onlyLoadAppFromAsar: false,
  },

  // Ship the compiled shell plus its production dependencies (which include the
  // entire DSH installation).
  files: [
    'dist/**/*',
    'package.json',
    '!**/*.map',
    '!**/*.md',
    '!**/test/**',
    '!**/tests/**',
    '!**/__tests__/**',
    '!**/example/**',
    '!**/examples/**',
    '!**/.github/**',
  ],

  // Everything a child process must execute, plus the DSH tree it resolves
  // through the filesystem.
  //
  // `node_modules/@deepseek-ai/dsh-host-directory-picker-native/**` is listed
  // because that package spawns `lib/worker.cjs` as a CHILD PROCESS. Electron
  // reports such a file's URL inside `app.asar`, and `spawn` cannot execute a
  // path that exists only in the archive — the child dies before reporting a
  // result, which the UI shows as
  // "win32 folder dialog worker exited before reporting a result".
  // Unpacking puts a real file on disk; `host.ts` rewrites the asar path to the
  // unpacked one at spawn time (see `useUnpackedDshTree`).
  asarUnpack: [
    '**/*.node',
    '**/*.dll',
    '**/*.exe',
    '**/*.wasm',
    '**/node-pty/**',
    '**/koffi/**',
    '**/@koromix/**',
    'node_modules/@deepseek-ai/**',
    // The index-rebuild worker script is loaded via `new Worker()`, whose module
    // loader cannot read from inside asar — it must sit on real disk.
    'dist/main/index-rebuild-worker.js',
    // …and the worker imports the UNPACKED dsh-tool-example, whose bare imports
    // only search app.asar.unpacked/node_modules — so its deps must be there too.
    ...EXAMPLE_RUNTIME_DEPS.map((d) => `node_modules/${d}/**`),
  ],

  extraResources: [
    // The application-owned DSH profile, read with fs at runtime.
    { from: 'desktop-profile', to: 'desktop-profile', filter: ['**/*'] },

    // Tray icon: src/main/tray.ts resolves `resources/icon.png` when packaged
    // and `assets/icon.png` in development.
    { from: 'assets/icon.png', to: 'icon.png' },

    // wecom-cli is NOT bundled (the WeCom archive backend is optional). To ship
    // it, add e.g. `@wecom/cli-win32-x64` as a devDependency and copy its
    // `bin/wecom-cli.exe` to `wecom-cli/wecom-cli.exe` here; the archive plugin
    // and the settings window probe that path.

    // Project preset template (no machine paths; placeholders are filled by
    // src/main/agent-preset.ts on first launch).
    { from: 'assets/agent-preset', to: 'agent-preset' },
    // First-run model selection (no secrets); src/main/model-preset.ts appends it
    // to settings.yaml.
    { from: 'assets/model-preset', to: 'model-preset' },

    /*
     * Give the profile its OWN resolution path to the DSH packages.
     *
     * `client-modules` locates each package manifest with
     * `createRequire(baseUrl).resolve(...)`, where the base is the PROFILE
     * directory, because it cannot use `loader.internal.resolveSync` (that
     * requires Node's `--expose-internals`, which Electron cannot provide).
     *
     * In a source checkout the profile sits inside the project, so Node's
     * upward lookup reaches the project's `node_modules` and the resolve
     * succeeds by accident. Once packaged there is nothing above the profile to
     * find, every package fails to resolve, the client graph composes empty, and
     * the UI reports "Failed to load plugins".
     *
     * Copying the DSH tree under the profile makes that resolution work in the
     * packaged layout too, without depending on layout luck.
     */
    {
      from: 'node_modules/@deepseek-ai',
      to: 'desktop-profile/node_modules/@deepseek-ai',
      filter: ['**/*'],
    },

    /*
     * …and the ORDINARY npm dependencies of those packages must come too.
     *
     * DSH packages import plain packages — `zod`, `chokidar`, `commander`,
     * `js-yaml` and ~28 more. Node resolves a bare specifier by walking UP from
     * the importing file, so a file at
     * `desktop-profile/node_modules/@deepseek-ai/dsh-llm/lib/` looks in
     * `desktop-profile/node_modules/` and finds only `@deepseek-ai`. It never
     * looks inside `app.asar`, so every one of those imports fails at boot with
     * ERR_MODULE_NOT_FOUND — the typert loader alone lost 15 contributors this
     * way, each reported separately, so fixing only the first one hides the rest.
     *
     * Copying just these packages (rather than the whole 622 MB `node_modules`)
     * keeps the installer reasonable; `scripts/audit-profile-dependencies.mjs`
     * recomputes the list from the real import graph so a new DSH release that
     * adds a dependency is caught at build time instead of at a user's launch.
     */
    {
      from: 'node_modules',
      to: 'desktop-profile/node_modules',
      filter: [
        '@agentclientprotocol/sdk/**/*',
        '@babel/code-frame/**/*',
        '@earendil-works/pi-ai/**/*',
        '@joplin/turndown-plugin-gfm/**/*',
        '@modelcontextprotocol/sdk/**/*',
        '@octokit/webhooks/**/*',
        '@opentelemetry/api-logs/**/*',
        '@opentelemetry/exporter-logs-otlp-http/**/*',
        '@opentelemetry/resources/**/*',
        '@opentelemetry/sdk-logs/**/*',
        /*
         * BOTH halves of the ripgrep pair are required.
         *
         * `@vscode/ripgrep` is only the JS wrapper; it locates the executable
         * with `require.resolve('@vscode/ripgrep-<platform>-<arch>/bin/rg.exe')`.
         * Shipping the wrapper without the platform package makes that resolve
         * throw MODULE_NOT_FOUND, so `resolveRgPath()` rejects and the glob/grep
         * tools report "subprocess failed before reporting an outcome (ripgrep
         * provider failure)". The platform package is an optionalDependency, so
         * it is never pulled in implicitly — it must be named explicitly here.
         */
        '@vscode/ripgrep/**/*',
        '@vscode/ripgrep-win32-x64/**/*',
        'chokidar/**/*',
        'commander/**/*',
        'compression/**/*',
        'diff/**/*',
        'eventsource-parser/**/*',
        'fflate/**/*',
        'ipaddr.js/**/*',
        'js-yaml/**/*',
        'koffi/**/*',
        'mime-types/**/*',
        'negotiator/**/*',
        'node-addon-require-builtin/**/*',
        'node-pty/**/*',
        'picomatch/**/*',
        'resolve.exports/**/*',
        'sharp/**/*',
        'turndown/**/*',
        'undici/**/*',
        'ws/**/*',
        'yaml/**/*',
        'zod/**/*',
      ],
    },

    /*
     * The local tool package's own runtime deps. npm hoists them to the ROOT
     * `node_modules` (NOT `packages/<tool>/node_modules` — copying from there
     * silently ships nothing and the packaged tool fails with "Cannot find
     * module"). Same list is asar-unpacked above for the index-rebuild worker.
     */
    ...(EXAMPLE_RUNTIME_DEPS.length > 0
      ? [{
          from: 'node_modules',
          to: 'desktop-profile/node_modules',
          filter: EXAMPLE_RUNTIME_DEPS.map((d) => `${d}/**/*`),
        }]
      : []),
  ],

  // Keep the build reproducible and the artifact smaller: these are build-time
  // only.
  npmRebuild: false,

  // The local `file:` packages are npm junctions; extraResources copies them as
  // links to the build machine. Replace them with real files (and fail on any
  // leftover link) so the output runs on a machine without this checkout.
  afterPack: './scripts/after-pack.cjs',

  // Beside the exe: one-time WeCom bot authorization helper for the optional
  // WeCom feedback-archive backend.
  extraFiles: [{ from: 'assets/wecom-auth.cmd', to: 'wecom-auth.cmd' }],
}
