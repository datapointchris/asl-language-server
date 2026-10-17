import type { JSONDocument, LanguageService } from 'amazon-states-language-service'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { parse as parseYaml } from 'yaml-language-server/out/server/src/languageservice/parser/yamlParser07'
import { type AstNode, type StateScope, stateScopes } from './state-graph.ts'
import { type Format, type ScannedTemplate, scanTemplate } from './template-syntax/scan.ts'

export interface DocumentAnalysis {
  format: Format
  template: ScannedTemplate
  // The document as the ASL service sees it: every template span overwritten, every offset unchanged.
  masked: TextDocument
  jsonDocument: JSONDocument
  scopes: StateScope[]
}

export function formatOf(document: TextDocument): Format {
  return document.languageId === 'asl-yaml' || /\.ya?ml(\.tftpl)?$/i.test(document.uri) ? 'yaml' : 'json'
}

export function analyze(document: TextDocument, jsonService: LanguageService): DocumentAnalysis {
  const format = formatOf(document)
  const template = scanTemplate(document.getText(), format)
  const masked = TextDocument.create(document.uri, document.languageId, document.version, template.masked)
  // The YAML service parses YAML itself and ignores this argument, as the AWS Toolkit's server does.
  const jsonDocument = jsonService.parseJSONDocument(masked)
  const root =
    format === 'yaml'
      ? (parseYaml(template.masked).documents[0]?.root as AstNode | undefined)
      : (jsonDocument as unknown as { root?: AstNode }).root
  return { format, template, masked, jsonDocument, scopes: stateScopes(root) }
}
