// The executable's entry. It answers --version and --help, and refuses a start with no
// transport, before the language libraries load. The server and the libraries it imports are
// most of the bundle, and loading them costs a quarter of a second that none of those three needs.

import { VERSION } from './version.ts'

const USAGE = `asl-language-server ${VERSION}
Language server for Amazon States Language: *.asl.json, *.asl.yaml and *.asl.yml,
each also as a Terraform template ending in .tftpl.

Usage: asl-language-server --stdio

Reads the Terraform templatefile() calls and SAM DefinitionSubstitutions under the
workspace root, so \${...} and %{...} in a definition are checked against what fills them.
`

const TRANSPORTS = ['--stdio', '--node-ipc', '--socket', '--pipe']

if (process.argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(USAGE)
  process.exit(0)
}
if (!process.argv.slice(2).some((arg) => TRANSPORTS.some((flag) => arg.startsWith(flag)))) {
  process.stderr.write(`${USAGE}\nasl-language-server: no transport given; an editor starts it with --stdio\n`)
  process.exit(2)
}

void import('./server.ts')
