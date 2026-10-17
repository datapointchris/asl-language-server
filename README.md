# asl-language-server

A language server for Amazon States Language: the JSON or YAML that defines an AWS Step Functions
state machine. It gives any LSP editor what the AWS Toolkit gives VS Code — schema validation,
completion, hover, and checks on JSONPath, intrinsic functions, JSONata and state names — and adds
two things the Toolkit lacks.

- **Definitions that are templates still validate.** A definition rendered by Terraform's
  `templatefile()` or SAM's `DefinitionSubstitutions` is full of `${...}`, and Terraform adds
  `%{ for }` and `%{ if }`. Those are checked against the `.tf` files or SAM template that fill
  them, and they no longer produce parse errors.
- **State names are navigable.** Go to definition, find references, highlight and rename work on
  every `StartAt`, `Next`, `Default` and `Catch` target.

It handles files named `*.asl.json`, `*.asl.yaml` and `*.asl.yml`, and each of those with the
`.tftpl` suffix Terraform recommends for a `templatefile()` template.

## Starting from scratch

It is one JavaScript file that runs on Node 20 or later.

```bash
# 1. Download the newest release and the checksum beside it
tag=$(curl -fsSL https://api.github.com/repos/datapointchris/asl-language-server/releases/latest | jq -r .tag_name)
base=https://github.com/datapointchris/asl-language-server/releases/download/$tag/asl-language-server-${tag#v}.cjs
curl -fsSLO "$base" && curl -fsSLO "$base.sha256"

# 2. Check it, then put it on PATH under its command name
sha256sum -c "asl-language-server-${tag#v}.cjs.sha256"
install -m 755 "asl-language-server-${tag#v}.cjs" ~/.local/bin/asl-language-server

# 3. Prove it runs
asl-language-server --version
```

Then tell Neovim (0.11 or later) which files are definitions and how to start the server:

```lua
vim.filetype.add({
  pattern = {
    ['.*%.asl%.json'] = 'asl',
    ['.*%.asl%.json%.tftpl'] = 'asl',
    ['.*%.asl%.ya?ml'] = 'asl-yaml',
    ['.*%.asl%.ya?ml%.tftpl'] = 'asl-yaml',
  },
})
vim.treesitter.language.register('json', 'asl')
vim.treesitter.language.register('yaml', 'asl-yaml')

vim.lsp.config('asl_ls', {
  cmd = { 'asl-language-server', '--stdio' },
  filetypes = { 'asl', 'asl-yaml' },
  root_markers = { '.git' },
})
vim.lsp.enable('asl_ls')
```

Open a definition and run `:checkhealth vim.lsp`: `asl_ls` should be listed as attached. Another
editor starts the same command with `--stdio`, sending the language id `asl` for JSON and
`asl-yaml` for YAML.

## How template syntax is read

Before the ASL checks see a file, every `${...}` and `%{...}` in it is overwritten with text of the
same length that parses — a value, a key, padding inside a string, or whitespace, depending on
where it sits. Every offset in the file stays where it was, so every diagnostic, hover and edit
lands on the text you wrote. What that costs:

- A finding inside a template span is dropped. `"TimeoutSeconds": ${timeout}` is not reported as
  the wrong type, because its type is decided when Terraform renders it.
- When a template touches the state graph, the graph checks are dropped for the whole file: an
  unknown `Next`, `Default` or `StartAt`, an unreachable state, and a machine with no `End`. A
  directive counts, and so does an interpolated state name, state reference or `End`, because the
  rendered graph cannot be known.
- Only the `%{ if }` branch is checked, never `%{ else }`, so the two are not read as one object
  holding both. A `%{ for }` body is checked once.
- Formatting changes whitespace outside template spans only.

## Where variables come from

The server reads the workspace root the editor sends, skipping `.git`, `.terraform`,
`node_modules` and build output.

- **Terraform**: every `templatefile()` call whose first argument resolves to the open file.
  `path.module`, `path.root` and `path.cwd` are read as the calling file's directory. Any other
  interpolation in the path matches one path segment, so a `for_each` over templates finds its
  file. Any other first argument, such as `format("%s/orders.asl.json", path.module)`, matches when
  it contains the open file's name. One that never names it, such as `local.template`, is not
  found.
- **SAM**: every `AWS::Serverless::StateMachine` whose `DefinitionUri` names the open file.

A name no caller passes is an error under Terraform, whose plan fails on it. Under SAM it is a
warning, since SAM leaves the text in the definition as written. Hover on a name shows the value
each caller passes, go to definition opens it, and completion inside `${` offers every name. A
variables argument that is not an object literal, such as `merge(local.a, local.b)`, cannot be
read, so names are not checked against that caller.

## Developing

```bash
task setup     # npm ci
task test      # vitest
task lint      # eslint, the prettier check and tsc
task install   # build and copy this checkout's server to ~/.local/bin
```
