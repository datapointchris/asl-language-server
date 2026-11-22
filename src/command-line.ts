// The executable's entry. It answers --version and --help, and refuses a start with no
// transport, before the language libraries load. The server and the libraries it imports are
// most of the bundle, and loading them costs a quarter of a second that none of those three needs.

import { VERSION } from './version.ts'

const USAGE = `asl-language-server ${VERSION}
Language server for Amazon States Language: *.asl.json, *.asl.yaml and
*.asl.yml, each also as a Terraform template ending in .tftpl.

Usage: asl-language-server --stdio

Reads the Terraform templatefile() calls and SAM DefinitionSubstitutions
under the workspace root, so \${...} and %{...} in a definition are checked
against what fills them.
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
const args = process.argv.slice(2)
if (!args.some((arg) => TRANSPORTS.some((flag) => arg.startsWith(flag)))) {
  process.stderr.write(refusal(args))
  process.exit(2)
}

// The error for a start with no transport. It names the first argument it refused and the
// transports it takes. It suggests a transport that is a prefix or near spelling of that
// argument, and points at --help for usage.
function refusal(args: string[]): string {
  const lines: string[] = []
  const refused = args[0]
  if (refused === undefined) {
    lines.push('asl-language-server: no transport given')
  } else {
    lines.push(`asl-language-server: unknown argument '${refused}'; it takes no files`)
    const near = TRANSPORTS.filter((flag) => (refused.length >= 3 && flag.startsWith(refused)) || editDistance(refused, flag) <= 2)
    if (near.length > 0) lines.push(`Did you mean ${near.join(' or ')}?`)
  }
  lines.push(`It starts on one transport: ${TRANSPORTS.join(', ')}.`)
  lines.push('An editor starts it with --stdio.')
  lines.push("Run 'asl-language-server --help' for usage.")
  return `${lines.join('\n')}\n`
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, substitution))
    }
    previous = current
  }
  return previous[b.length]
}

void import('./server.ts')
