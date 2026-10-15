// Probe how `web-startup` parses cmdlineArgs, so the shell passes the right
// argument shape. Mirrors dsh-web-app/startup.js exactly, minus the plugin.
// Run: node scripts/diagnostics/check-cmdline.mjs
import { Command } from 'commander'

function tryParse(args) {
  const program = new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority')

  let captured = null
  program.action(() => {
    const o = program.opts()
    captured = { openBrowser: o.open, host: o.host, port: o.port, trustedHosts: o.trustedHost ?? [] }
  })
  program.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })

  let error = null
  try {
    program.parse(args, { from: 'user' })
  } catch (e) {
    error = `${e.code ?? 'ERR'}: ${e.message}`
  }
  return { args, actionRan: captured !== null, captured, error }
}

const cases = [
  ['--no-open', '--port', '0'],
  ['dsh --profile web', '--no-open', '--port', '0'],
  ['web', '--no-open'],
  ['--no-open'],
]
for (const args of cases) {
  console.log(JSON.stringify(tryParse(args)))
}
