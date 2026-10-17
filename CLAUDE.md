# asl-language-server

An LSP server for Amazon States Language. AWS's `amazon-states-language-service` does the ASL work —
schema, JSONPath, intrinsics, JSONata, state-name checks, completion, hover, symbols, formatting.
This repo puts it on stdio, and adds template awareness and state-name navigation. The README is
the user's account; this is what an edit here has to keep true.

## The masking invariant

`src/template-syntax/scan.ts` overwrites every `${...}` and `%{...}` before the library sees the
text. **The masked text has the same length as the original, with every `\n` and `\r` where it
was.** Every handler passes positions straight through, from the library's results and from its
own walks over the masked AST, with no mapping layer. A mask that changes one length moves every
diagnostic after it. A mask that drops a newline moves every line below it.

What a span becomes depends on where it sits in the JSON, which the scanner tracks as it goes:
`x` padding inside a string, `0` where a value is expected, `"":0` where a key is expected, and
whitespace after a value or for any directive. YAML gets `x` padding everywhere, since a plain
scalar takes it.

## Why some library findings are dropped

`diagnostics.ts` drops a finding that overlaps a span, since what the span renders to is unknown.
It also drops the five graph messages (`GRAPH_MESSAGES`) for the whole file once a template
touches the graph. Those report on ranges away from any span. An interpolated `Next` marks its real
target unreachable, on a different state's key. The messages are matched through the constants
the library exports, so a reworded message in a new release still matches.

## State names

`state-graph.ts` walks the AST the JSON service produces and the one yaml-language-server
produces. Both share one node shape. Every `States` object is its own scope, so a Parallel branch
or Map processor may reuse an outer name, and `test/state-graph.test.ts` pins that.

## The build, and why each pin is where it is

- **esbuild bundles to one CommonJS file**, `dist/asl-language-server.cjs`, which is the release
  asset. `build.ts` redirects two of yaml-language-server's imports. Its deep imports of
  `vscode-json-languageservice/lib/umd/...` fail at runtime when bundled, because a UMD factory
  hides its requires, so they resolve to the identical `lib/esm/` files. Its `require('prettier')`
  resolves to `prettier/standalone`, which is all its YAML formatter uses, and that alone took the
  bundle from 14 MB to under 4 MB.
- **Two prettiers are installed on purpose.** yaml-language-server needs its own 2.0.5, nested
  under it. The root prettier 3 is the repo's formatter. A dev dependency on `prettier` with no
  version range resolves to the hoisted 2.0.5 and breaks `eslint-plugin-prettier`.
- **TypeScript stays below 6.1**, the ceiling of `typescript-eslint`'s peer range.
- **`vscode-languageserver` 10** carries the same `vscode-languageserver-types` the library
  resolves. Version 9 carries an older copy, and the two `Diagnostic` types do not assign.
- Imports keep their `.ts` extensions, and `erasableSyntaxOnly` holds, so vitest and esbuild read
  the sources directly.

## Releasing

The tag is the version. `package.json` holds `0.0.0` and is never bumped in git. The release
workflow's build job checks out the tag, runs `npm version --no-git-tag-version`, builds, and
attaches the bundle with a `.sha256` beside it.

## Verifying a change

`task test` covers the user-facing behavior on the fixtures in `test/fixtures/workspace`: a
Terraform-rendered definition, a directive-heavy one, a SAM one and a JSONata YAML one. A change
to a handler in `server.ts` is verified by driving the built server. Run `task install`, then
open a fixture in Neovim with the README's config.
