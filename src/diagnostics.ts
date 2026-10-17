import path from 'node:path'
import type { LanguageService } from 'amazon-states-language-service'
import { MESSAGES } from 'amazon-states-language-service/out/constants/diagnosticStrings'
import { type Diagnostic, DiagnosticSeverity } from 'vscode-languageserver'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { DocumentAnalysis } from './document-analysis.ts'
import type { StateScope } from './state-graph.ts'
import type { Supplier } from './substitution-sources/supplier.ts'
import { overlapsSpan, type ScannedTemplate } from './template-syntax/scan.ts'

// Checks over the whole machine. A template can rename a state, retarget a Next or loop over
// states, so none of these can be trusted once a span touches the graph, wherever they point.
const GRAPH_MESSAGES = new Set<string>([
  MESSAGES.INVALID_NEXT,
  MESSAGES.INVALID_DEFAULT,
  MESSAGES.INVALID_START_AT,
  MESSAGES.UNREACHABLE_STATE,
  MESSAGES.NO_TERMINAL_STATE,
])

// What the ASL service finds in the masked document, less what the template caused, plus the
// template's own errors.
export async function diagnose(
  document: TextDocument,
  analysis: DocumentAnalysis,
  service: LanguageService,
  suppliers: Supplier[],
  root: string,
): Promise<Diagnostic[]> {
  if (document.getText().trim().length === 0) return []
  const found = await service.doValidation(analysis.masked, analysis.jsonDocument, { comments: 'error', trailingCommas: 'error' })
  const graphTouched = graphTouchedByTemplate(analysis.template, analysis.scopes, analysis.masked.getText())
  return [
    ...withoutTemplateNoise(found, document, analysis.template, graphTouched),
    ...templateDiagnostics(document, analysis.template, suppliers, root),
  ]
}

export function graphTouchedByTemplate(template: ScannedTemplate, scopes: StateScope[], masked: string): boolean {
  for (const span of template.spans) {
    if (span.kind === 'directive') return true
    if (span.kind !== 'interpolation') continue
    if (span.slot === 'key') return true
    if (span.slot === 'value' && /"End"\s*:\s*$/.test(masked.slice(Math.max(0, span.start - 32), span.start))) return true
  }
  return scopes.some(
    (scope) =>
      [...scope.declarations.values()].some((node) => overlapsSpan(template.spans, node.offset, node.offset + node.length)) ||
      scope.references.some(({ node }) => overlapsSpan(template.spans, node.offset, node.offset + node.length)),
  )
}

export function withoutTemplateNoise(
  diagnostics: Diagnostic[],
  document: TextDocument,
  template: ScannedTemplate,
  graphTouched: boolean,
): Diagnostic[] {
  return diagnostics.filter((diagnostic) => {
    if (graphTouched && typeof diagnostic.message === 'string' && GRAPH_MESSAGES.has(diagnostic.message)) return false
    const start = document.offsetAt(diagnostic.range.start)
    const end = document.offsetAt(diagnostic.range.end)
    return !overlapsSpan(template.spans, start, end === start ? end + 1 : end)
  })
}

export function templateDiagnostics(document: TextDocument, template: ScannedTemplate, suppliers: Supplier[], root: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const range = (start: number, end: number) => ({ start: document.positionAt(start), end: document.positionAt(end) })

  for (const span of template.spans) {
    if (span.kind !== 'skipped' && !span.closed) {
      const opener = span.kind === 'interpolation' ? '${' : '%{'
      diagnostics.push({
        range: range(span.start, span.end),
        severity: DiagnosticSeverity.Error,
        source: 'template',
        message: `Unterminated ${opener}: the template has no closing }.`,
      })
    }
  }

  const known = suppliers.filter((supplier) => supplier.variables !== undefined)
  if (known.length === 0) return diagnostics

  for (const span of template.spans) {
    if (span.kind === 'skipped') continue
    for (const reference of span.references) {
      const bound = template.loops.some(
        (loop) =>
          reference.start >= loop.start && reference.start < loop.end && loop.bindings.some((binding) => binding.name === reference.name),
      )
      if (bound) continue
      const missing = known.filter((supplier) => !supplier.variables?.some((v) => v.name === reference.name))
      if (missing.length === 0) continue
      const where = missing.map((supplier) => `${describeSupplier(supplier)} at ${location(supplier, root)}`).join(', ')
      const errors = missing.some((supplier) => supplier.unknownIs === 'error')
      diagnostics.push({
        range: range(reference.start, reference.end),
        severity: errors ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
        source: 'template',
        message: errors
          ? `"${reference.name}" is not passed by ${where}.`
          : `"${reference.name}" is not in ${where}, so Step Functions receives it as literal text.`,
      })
    }
  }
  return diagnostics
}

export function describeSupplier(supplier: Supplier): string {
  return supplier.kind === 'terraform' ? 'templatefile()' : supplier.variablesExpression
}

export function location(supplier: Supplier, root: string): string {
  return `${path.relative(root, supplier.file)}:${supplier.position.line + 1}`
}
