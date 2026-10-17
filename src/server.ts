import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ClientCapabilities, getLanguageService, getYamlLanguageService, type LanguageService } from 'amazon-states-language-service'
import {
  type CompletionItem,
  CompletionItemKind,
  createConnection,
  DidChangeWatchedFilesNotification,
  DocumentHighlightKind,
  type Hover,
  type InitializeParams,
  type Location,
  MarkupKind,
  ProposedFeatures,
  type Range,
  SemanticTokensBuilder,
  type TextEdit,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { describeSupplier, diagnose, location } from './diagnostics.ts'
import { analyze, type DocumentAnalysis } from './document-analysis.ts'
import { type AstNode, occurrences, stateAt, writtenName } from './state-graph.ts'
import type { Supplier } from './substitution-sources/supplier.ts'
import { SupplierIndex } from './substitution-sources/workspace.ts'
import type { Reference } from './template-syntax/hcl.ts'
import { overlapsSpan, type Span } from './template-syntax/scan.ts'

declare const ASL_LANGUAGE_SERVER_VERSION: string
const VERSION = typeof ASL_LANGUAGE_SERVER_VERSION === 'string' ? ASL_LANGUAGE_SERVER_VERSION : 'dev'

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

const TOKEN_TYPES = ['macro', 'keyword', 'variable']
const VALIDATION_DELAY_MS = 200
const TEMPLATE_COMPLETION = 'template-variable'
const SUPPLIER_GLOBS = ['**/*.tf', '**/*.{yaml,yml}']

const connection = createConnection(ProposedFeatures.all)
const documents = new TextDocuments(TextDocument)
const suppliers = new SupplierIndex((message) => connection.console.log(message))
const analyses = new Map<string, { version: number; analysis: DocumentAnalysis }>()
const pendingValidation = new Map<string, NodeJS.Timeout>()
let workspaceRoots: string[] = []
let jsonService: LanguageService = getLanguageService({ clientCapabilities: ClientCapabilities.LATEST })
let yamlService: LanguageService = getYamlLanguageService({ clientCapabilities: ClientCapabilities.LATEST })
let canWatchFiles = false

connection.onInitialize((params: InitializeParams) => {
  jsonService = getLanguageService({ clientCapabilities: params.capabilities })
  yamlService = getYamlLanguageService({ clientCapabilities: params.capabilities })
  canWatchFiles = params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true
  const folders = params.workspaceFolders?.map((folder) => folder.uri) ?? (params.rootUri ? [params.rootUri] : [])
  workspaceRoots = folders.filter((uri) => uri.startsWith('file:')).map((uri) => fileURLToPath(uri))
  return {
    serverInfo: { name: 'asl-language-server', version: VERSION },
    capabilities: {
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: { includeText: false } },
      completionProvider: { resolveProvider: true, triggerCharacters: ['"', '{'] },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      foldingRangeProvider: true,
      selectionRangeProvider: true,
      semanticTokensProvider: { legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: [] }, full: true },
    },
  }
})

// A changed .tf file or SAM template can add or remove a variable every open definition reads.
connection.onInitialized(() => {
  if (!canWatchFiles) return
  void connection.client.register(DidChangeWatchedFilesNotification.type, {
    watchers: SUPPLIER_GLOBS.map((globPattern) => ({ globPattern })),
  })
})

connection.onDidChangeWatchedFiles(() => {
  suppliers.forgetListings()
  for (const document of documents.all()) scheduleValidation(document, VALIDATION_DELAY_MS)
})

function analysisOf(document: TextDocument): DocumentAnalysis {
  const cached = analyses.get(document.uri)
  if (cached?.version === document.version) return cached.analysis
  const analysis = analyze(document, jsonService)
  analyses.set(document.uri, { version: document.version, analysis })
  return analysis
}

function serviceFor(analysis: DocumentAnalysis): LanguageService {
  return analysis.format === 'yaml' ? yamlService : jsonService
}

function documentPath(document: TextDocument): string | undefined {
  return document.uri.startsWith('file:') ? fileURLToPath(document.uri) : undefined
}

function rootOf(file: string): string {
  const containing = workspaceRoots.filter((root) => file.startsWith(root + path.sep)).sort((a, b) => b.length - a.length)[0]
  return containing ?? path.dirname(file)
}

function suppliersOf(document: TextDocument): { list: Supplier[]; root: string } {
  const file = documentPath(document)
  if (!file) return { list: [], root: '' }
  const root = rootOf(file)
  return { list: suppliers.suppliersFor(file, root), root }
}

function rangeOf(document: TextDocument, start: number, end: number): Range {
  return { start: document.positionAt(start), end: document.positionAt(end) }
}

async function validate(document: TextDocument): Promise<void> {
  const analysis = analysisOf(document)
  const { list, root } = suppliersOf(document)
  const diagnostics = await diagnose(document, analysis, serviceFor(analysis), list, root)
  if (documents.get(document.uri)?.version === document.version) {
    await connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics })
  }
}

function scheduleValidation(document: TextDocument, delay: number): void {
  clearTimeout(pendingValidation.get(document.uri))
  pendingValidation.set(
    document.uri,
    setTimeout(() => {
      pendingValidation.delete(document.uri)
      validate(document).catch((error: unknown) => connection.console.error(`validating ${document.uri}: ${String(error)}`))
    }, delay),
  )
}

documents.onDidOpen(({ document }) => scheduleValidation(document, 0))
documents.onDidChangeContent(({ document }) => scheduleValidation(document, VALIDATION_DELAY_MS))
documents.onDidSave(({ document }) => scheduleValidation(document, 0))
documents.onDidClose(({ document }) => {
  clearTimeout(pendingValidation.get(document.uri))
  analyses.delete(document.uri)
  void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] })
})

// The template span whose expression holds the offset, including one still being typed.
function expressionAt(spans: Span[], offset: number): Exclude<Span, { kind: 'skipped' }> | undefined {
  for (const span of spans) {
    if (span.kind !== 'skipped' && offset >= span.expressionStart && offset <= span.expressionEnd) return span
  }
  return undefined
}

function referenceAt(analysis: DocumentAnalysis, offset: number): Reference | undefined {
  for (const span of analysis.template.spans) {
    if (span.kind === 'skipped') continue
    const hit = span.references.find((r) => offset >= r.start && offset <= r.end)
    if (hit) return hit
  }
  for (const loop of analysis.template.loops) {
    const hit = loop.bindings.find((b) => offset >= b.start && offset <= b.end)
    if (hit) return hit
  }
  return undefined
}

// The binding a name at this offset resolves to: the innermost enclosing loop that binds it.
function loopBinding(analysis: DocumentAnalysis, name: string, offset: number): Reference | undefined {
  let innermost: { binding: Reference; start: number } | undefined
  for (const loop of analysis.template.loops) {
    const binding = loop.bindings.find((b) => b.name === name)
    if (!binding) continue
    if (offset >= binding.start && offset <= binding.end) return binding
    if (offset >= loop.start && offset < loop.end && (!innermost || loop.start > innermost.start)) {
      innermost = { binding, start: loop.start }
    }
  }
  return innermost?.binding
}

function sameVariable(analysis: DocumentAnalysis, name: string, offset: number): Reference[] {
  const binding = loopBinding(analysis, name, offset)
  const all = analysis.template.spans.flatMap((span) => (span.kind === 'skipped' ? [] : span.references))
  const matching = all.filter((r) => r.name === name && loopBinding(analysis, name, r.start) === binding)
  return binding ? [binding, ...matching] : matching
}

connection.onCompletion(async ({ textDocument, position }) => {
  const document = documents.get(textDocument.uri)
  if (!document) return null
  const analysis = analysisOf(document)
  const offset = document.offsetAt(position)
  const span = expressionAt(analysis.template.spans, offset)
  if (!span) return serviceFor(analysis).doComplete(analysis.masked, position, analysis.jsonDocument)

  const text = document.getText()
  let wordStart = offset
  while (wordStart > span.expressionStart && /[A-Za-z0-9_-]/.test(text[wordStart - 1])) wordStart--
  if (text[wordStart - 1] === '.') return { isIncomplete: false, items: [] }
  const replace = rangeOf(document, wordStart, offset)
  const items = new Map<string, CompletionItem>()
  const { list, root } = suppliersOf(document)
  for (const supplier of list) {
    for (const variable of supplier.variables ?? []) {
      if (items.has(variable.name)) continue
      items.set(variable.name, {
        label: variable.name,
        kind: CompletionItemKind.Variable,
        detail: `${describeSupplier(supplier)} at ${location(supplier, root)}`,
        documentation: { kind: MarkupKind.Markdown, value: codeBlock(supplier, `${variable.name} = ${variable.value}`) },
        textEdit: { range: replace, newText: variable.name },
        data: TEMPLATE_COMPLETION,
      })
    }
  }
  for (const loop of analysis.template.loops) {
    if (offset < loop.start || offset >= loop.end) continue
    for (const binding of loop.bindings) {
      items.set(binding.name, {
        label: binding.name,
        kind: CompletionItemKind.Variable,
        detail: '%{ for } loop variable',
        textEdit: { range: replace, newText: binding.name },
        data: TEMPLATE_COMPLETION,
      })
    }
  }
  return { isIncomplete: false, items: [...items.values()] }
})

connection.onCompletionResolve((item) => (item.data === TEMPLATE_COMPLETION ? item : jsonService.doResolve(item)))

function codeBlock(supplier: Supplier, body: string): string {
  return `\`\`\`${supplier.kind === 'terraform' ? 'hcl' : 'yaml'}\n${body}\n\`\`\``
}

connection.onHover(async ({ textDocument, position }): Promise<Hover | null> => {
  const document = documents.get(textDocument.uri)
  if (!document) return null
  const analysis = analysisOf(document)
  const offset = document.offsetAt(position)
  const reference = referenceAt(analysis, offset)
  if (reference) {
    const binding = loopBinding(analysis, reference.name, offset)
    if (binding) {
      const line = document.positionAt(binding.start).line + 1
      return {
        contents: { kind: MarkupKind.Markdown, value: `\`${reference.name}\`: loop variable from the \`%{ for }\` on line ${line}` },
      }
    }
    const { list, root } = suppliersOf(document)
    const sections = list.flatMap((supplier) => {
      const variable = supplier.variables?.find((v) => v.name === reference.name)
      const heading = `${describeSupplier(supplier)} at ${location(supplier, root)}`
      if (variable) return [`${heading}\n${codeBlock(supplier, `${variable.name} = ${variable.value}`)}`]
      if (supplier.variables === undefined)
        return [`${heading} passes \`${supplier.variablesExpression}\`, whose keys are not readable here`]
      return [`${heading} does **not** pass it`]
    })
    const body =
      sections.length > 0 ? sections.join('\n\n') : 'No templatefile() call or SAM template under the workspace root names this file.'
    return {
      contents: { kind: MarkupKind.Markdown, value: `\`${reference.name}\`\n\n${body}` },
      range: rangeOf(document, reference.start, reference.end),
    }
  }
  if (expressionAt(analysis.template.spans, offset)) return null
  return serviceFor(analysis).doHover(analysis.masked, position, analysis.jsonDocument)
})

function nodeRange(document: TextDocument, node: AstNode): Range {
  return rangeOf(document, node.offset, node.offset + node.length)
}

connection.onDefinition(({ textDocument, position }): Location[] | null => {
  const document = documents.get(textDocument.uri)
  if (!document) return null
  const analysis = analysisOf(document)
  const offset = document.offsetAt(position)
  const reference = referenceAt(analysis, offset)
  if (reference) {
    const binding = loopBinding(analysis, reference.name, offset)
    if (binding) return [{ uri: document.uri, range: rangeOf(document, binding.start, binding.end) }]
    return suppliersOf(document).list.flatMap((supplier) =>
      (supplier.variables ?? [])
        .filter((v) => v.name === reference.name)
        .map((v) => ({ uri: pathToFileURL(v.file).href, range: { start: v.position, end: v.endPosition } })),
    )
  }
  const target = stateAt(analysis.scopes, offset)
  const declaration = target?.scope.declarations.get(target.name)
  return declaration ? [{ uri: document.uri, range: nodeRange(document, declaration) }] : null
})

connection.onReferences(({ textDocument, position, context }): Location[] | null => {
  const document = documents.get(textDocument.uri)
  if (!document) return null
  const analysis = analysisOf(document)
  const offset = document.offsetAt(position)
  const reference = referenceAt(analysis, offset)
  if (reference) {
    return sameVariable(analysis, reference.name, offset).map((r) => ({ uri: document.uri, range: rangeOf(document, r.start, r.end) }))
  }
  const target = stateAt(analysis.scopes, offset)
  if (!target) return null
  return occurrences(target)
    .filter((o) => context.includeDeclaration || !o.declaration)
    .map((o) => ({ uri: document.uri, range: nodeRange(document, o.node) }))
})

connection.onDocumentHighlight(({ textDocument, position }) => {
  const document = documents.get(textDocument.uri)
  if (!document) return null
  const analysis = analysisOf(document)
  const offset = document.offsetAt(position)
  const reference = referenceAt(analysis, offset)
  if (reference) {
    return sameVariable(analysis, reference.name, offset).map((r) => ({
      range: rangeOf(document, r.start, r.end),
      kind: DocumentHighlightKind.Read,
    }))
  }
  const target = stateAt(analysis.scopes, offset)
  if (!target) return null
  return occurrences(target).map((o) => ({
    range: nodeRange(document, o.node),
    kind: o.declaration ? DocumentHighlightKind.Write : DocumentHighlightKind.Read,
  }))
})

function renameTarget(document: TextDocument, offset: number) {
  const analysis = analysisOf(document)
  const target = stateAt(analysis.scopes, offset)
  if (!target || !target.scope.declarations.has(target.name)) return undefined
  const nodes = occurrences(target).map((o) => o.node)
  if (nodes.some((node) => overlapsSpan(analysis.template.spans, node.offset, node.offset + node.length))) return undefined
  return { analysis, target, nodes }
}

connection.onPrepareRename(({ textDocument, position }) => {
  const document = documents.get(textDocument.uri)
  if (!document) return null
  const found = renameTarget(document, document.offsetAt(position))
  if (!found) return null
  return { range: nodeRange(document, found.target.node), placeholder: found.target.name }
})

connection.onRenameRequest(({ textDocument, position, newName }) => {
  const document = documents.get(textDocument.uri)
  if (!document) return null
  const found = renameTarget(document, document.offsetAt(position))
  if (!found) return null
  const text = document.getText()
  const edits: TextEdit[] = found.nodes.map((node) => ({
    range: nodeRange(document, node),
    newText: writtenName(text.slice(node.offset, node.offset + node.length), newName, found.analysis.format),
  }))
  return { changes: { [document.uri]: edits } }
})

connection.onDocumentSymbol(({ textDocument }) => {
  const document = documents.get(textDocument.uri)
  if (!document) return null
  const analysis = analysisOf(document)
  return serviceFor(analysis).findDocumentSymbols2(analysis.masked, analysis.jsonDocument)
})

function formatEdits(document: TextDocument, range: Range, options: { tabSize: number; insertSpaces: boolean }): TextEdit[] {
  const analysis = analysisOf(document)
  const edits = serviceFor(analysis).format(analysis.masked, range, options)
  // An edit touching a span would rewrite template syntax the formatter only saw as padding.
  return edits.filter(
    (edit) => !overlapsSpan(analysis.template.spans, document.offsetAt(edit.range.start), document.offsetAt(edit.range.end)),
  )
}

connection.onDocumentFormatting(({ textDocument, options }) => {
  const document = documents.get(textDocument.uri)
  if (!document) return null
  return formatEdits(document, rangeOf(document, 0, document.getText().length), options)
})

connection.onDocumentRangeFormatting(({ textDocument, range, options }) => {
  const document = documents.get(textDocument.uri)
  return document ? formatEdits(document, range, options) : null
})

connection.onFoldingRanges(({ textDocument }) => {
  const document = documents.get(textDocument.uri)
  if (!document) return null
  const analysis = analysisOf(document)
  return serviceFor(analysis).getFoldingRanges(analysis.masked)
})

connection.onSelectionRanges(({ textDocument, positions }) => {
  const document = documents.get(textDocument.uri)
  if (!document) return null
  const analysis = analysisOf(document)
  return serviceFor(analysis).getSelectionRanges(analysis.masked, positions, analysis.jsonDocument)
})

connection.languages.semanticTokens.on(({ textDocument }) => {
  const builder = new SemanticTokensBuilder()
  const document = documents.get(textDocument.uri)
  if (!document) return builder.build()
  const analysis = analysisOf(document)
  const tokens: Array<[number, number, number]> = []
  for (const span of analysis.template.spans) {
    if (span.kind === 'skipped') continue
    const delimiter = TOKEN_TYPES.indexOf(span.kind === 'interpolation' ? 'macro' : 'keyword')
    tokens.push([span.start, span.expressionStart, delimiter])
    if (span.closed) tokens.push([span.expressionEnd, span.end, delimiter])
    if (span.kind === 'directive' && span.keyword !== 'unknown') {
      const keywordStart = document.getText().indexOf(span.keyword, span.expressionStart)
      tokens.push([keywordStart, keywordStart + span.keyword.length, delimiter])
    }
    for (const reference of span.references) tokens.push([reference.start, reference.end, TOKEN_TYPES.indexOf('variable')])
  }
  for (const loop of analysis.template.loops) {
    for (const binding of loop.bindings) tokens.push([binding.start, binding.end, TOKEN_TYPES.indexOf('variable')])
  }
  tokens.sort((a, b) => a[0] - b[0])
  for (const [start, end, type] of tokens) {
    const at = document.positionAt(start)
    builder.push(at.line, at.character, end - start, type, 0)
  }
  return builder.build()
})

documents.listen(connection)
connection.listen()
