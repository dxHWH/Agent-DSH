// Reports the Node.js version and the specific APIs DSH requires.
// Run: npx electron scripts/diagnostics/check-node-apis.cjs
const zlib = require('node:zlib')
const util = require('node:util')
const mod = require('node:module')

console.log('electron:', process.versions.electron)
console.log('node:', process.versions.node)
console.log('chrome:', process.versions.chrome)
console.log('v8:', process.versions.v8)
console.log('--- DSH-required APIs ---')
console.log('zlib.createZstdCompress:', typeof zlib.createZstdCompress)
console.log('util.getSystemErrorMessage:', typeof util.getSystemErrorMessage)
console.log('module.stripTypeScriptTypes:', typeof mod.stripTypeScriptTypes)
console.log('zlib.createZstdDecompress:', typeof zlib.createZstdDecompress)
process.exit(0)
