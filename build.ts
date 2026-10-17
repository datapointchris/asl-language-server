import { chmodSync, readFileSync } from 'node:fs'
import { build, type Plugin } from 'esbuild'

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
const OUTFILE = 'dist/asl-language-server.cjs'

// Two of yaml-language-server's imports are redirected to smaller builds of the same code.
//
// It deep-imports vscode-json-languageservice's UMD files by path. A UMD module's requires sit
// inside a factory esbuild cannot follow, so they fail at runtime; the ESM build beside them holds
// the same modules.
//
// Its YAML formatter requires all of prettier and then passes the YAML parser in as a plugin, so
// prettier's standalone build is all it uses. The full one is most of the bundle.
const redirectYamlLanguageServerImports: Plugin = {
  name: 'redirect-yaml-language-server-imports',
  setup(build) {
    build.onResolve({ filter: /^vscode-json-languageservice\/lib\/umd\// }, (args) =>
      build.resolve(args.path.replace('/lib/umd/', '/lib/esm/'), { kind: args.kind, resolveDir: args.resolveDir }),
    )
    build.onResolve({ filter: /^prettier$/ }, (args) =>
      build.resolve('prettier/standalone', { kind: args.kind, resolveDir: args.resolveDir }),
    )
  },
}

await build({
  entryPoints: ['src/server.ts'],
  outfile: OUTFILE,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  mainFields: ['module', 'main'],
  plugins: [redirectYamlLanguageServerImports],
  banner: { js: '#!/usr/bin/env node' },
  define: { ASL_LANGUAGE_SERVER_VERSION: JSON.stringify(version) },
  legalComments: 'eof',
  logLevel: 'warning',
})

chmodSync(OUTFILE, 0o755)
