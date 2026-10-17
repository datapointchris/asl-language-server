import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ClientCapabilities, getLanguageService, getYamlLanguageService } from 'amazon-states-language-service'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { expect, test } from 'vitest'
import { diagnose } from '../src/diagnostics.ts'
import { analyze } from '../src/document-analysis.ts'
import { SupplierIndex } from '../src/substitution-sources/workspace.ts'

const WORKSPACE = path.join(import.meta.dirname, 'fixtures', 'workspace')
const jsonService = getLanguageService({ clientCapabilities: ClientCapabilities.LATEST })
const yamlService = getYamlLanguageService({ clientCapabilities: ClientCapabilities.LATEST })

async function diagnosticsFor(relative: string, edit: (text: string) => string = (text) => text): Promise<string[]> {
  const file = path.join(WORKSPACE, relative)
  const languageId = /\.ya?ml$/.test(file) ? 'asl-yaml' : 'asl'
  const document = TextDocument.create(pathToFileURL(file).href, languageId, 1, edit(fs.readFileSync(file, 'utf8')))
  const analysis = analyze(document, jsonService)
  const suppliers = new SupplierIndex(() => {}).suppliersFor(file, WORKSPACE)
  const service = analysis.format === 'yaml' ? yamlService : jsonService
  const found = await diagnose(document, analysis, service, suppliers, WORKSPACE)
  return found.map((d) => `${d.range.start.line + 1}: ${String(d.message)}`)
}

test('a templatefile() definition reports what Step Functions and Terraform would reject, and nothing its template syntax caused', async () => {
  expect(await diagnosticsFor('statemachines/orders.asl.json.tftpl')).toEqual([
    '20: The value of "Next" property must be the name of an existing state.',
    '4: No terminal state. The state machine must have at least one terminal state (a state in which the "End" property is set to true).',
    '19: "queue_url" is not passed by templatefile() at infra/main.tf:9.',
  ])
})

test('%{ for } and %{ if } directives leave only the variable no caller passes', async () => {
  expect(await diagnosticsFor('statemachines/fanout.asl.json.tftpl')).toEqual([
    '27: "undefined_error_name" is not passed by templatefile() at infra/main.tf:20.',
  ])
})

test('a SAM definition is checked against the DefinitionSubstitutions of the template naming it', async () => {
  expect(await diagnosticsFor('sam/statemachine/stock_trader.asl.json')).toEqual([])
  expect(await diagnosticsFor('sam/statemachine/stock_trader.asl.json', (text) => text.replace('${DDBTable}', '${DdbTable}'))).toEqual([
    '12: "DdbTable" is not in StockTradingStateMachine.DefinitionSubstitutions at sam/template.yaml:4, so Step Functions receives it as literal text.',
  ])
})

test('a YAML definition with JSONata is masked and validated the same way', async () => {
  expect(await diagnosticsFor('statemachines/jsonata.asl.yaml')).toEqual([])
  expect(await diagnosticsFor('statemachines/jsonata.asl.yaml', (text) => text.replace('Next: Report', 'Next: Nowhere'))).toEqual([
    '12: The value of "Next" property must be the name of an existing state.',
    '13: The state cannot be reached. It must be referenced by at least one other state.',
  ])
})
