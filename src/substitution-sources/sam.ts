import path from 'node:path'
import yaml from 'js-yaml'
import { lineOffsets, positionAt } from './terraform.ts'
import type { Supplier } from './supplier.ts'

const CLOUDFORMATION_TAGS = [
  'Ref',
  'GetAtt',
  'Sub',
  'Join',
  'Select',
  'Split',
  'FindInMap',
  'GetAZs',
  'ImportValue',
  'If',
  'Equals',
  'And',
  'Or',
  'Not',
  'Base64',
  'Cidr',
  'Condition',
  'Transform',
  'ToJsonString',
  'Length',
]

const SCHEMA = yaml.DEFAULT_SCHEMA.extend(
  CLOUDFORMATION_TAGS.flatMap((tag) =>
    (['scalar', 'sequence', 'mapping'] as const).map(
      (kind) => new yaml.Type(`!${tag}`, { kind, construct: (data: unknown) => ({ [`Fn::${tag}`]: data }) }),
    ),
  ),
)

interface Resource {
  Type?: unknown
  Properties?: { DefinitionUri?: unknown; DefinitionSubstitutions?: unknown }
}

export function samSuppliers(templateText: string, templatePath: string, documentPath: string): Supplier[] {
  if (!templateText.includes('AWS::Serverless::StateMachine')) return []
  let parsed: unknown
  try {
    parsed = yaml.load(templateText, { schema: SCHEMA })
  } catch {
    return []
  }
  const resources = (parsed as { Resources?: Record<string, Resource> } | undefined)?.Resources ?? {}
  const lineStarts = lineOffsets(templateText)
  const suppliers: Supplier[] = []

  for (const [logicalId, resource] of Object.entries(resources)) {
    const uri = resource?.Properties?.DefinitionUri
    if (resource?.Type !== 'AWS::Serverless::StateMachine' || typeof uri !== 'string') continue
    if (path.resolve(path.dirname(templatePath), uri) !== documentPath) continue

    const resourceStart = Math.max(0, templateText.search(new RegExp(`^\\s+${escape(logicalId)}\\s*:`, 'm')))
    const substitutionsStart = templateText.indexOf('DefinitionSubstitutions', resourceStart)
    const substitutions = resource.Properties?.DefinitionSubstitutions
    const variables =
      substitutions && typeof substitutions === 'object'
        ? Object.entries(substitutions).map(([name, value]) => {
            const keyPattern = new RegExp(`^\\s*(['"]?)${escape(name)}\\1\\s*:`, 'm')
            const found = templateText.slice(substitutionsStart).search(keyPattern)
            const lineStart = found === -1 ? substitutionsStart : substitutionsStart + found
            const start = templateText.indexOf(name, lineStart)
            return {
              name,
              value: describe(value),
              file: templatePath,
              position: positionAt(lineStarts, start),
              endPosition: positionAt(lineStarts, start + name.length),
            }
          })
        : []
    suppliers.push({
      kind: 'sam',
      file: templatePath,
      position: positionAt(lineStarts, resourceStart),
      variables,
      variablesExpression: `${logicalId}.DefinitionSubstitutions`,
      matchedBy: 'path',
      unknownIs: 'warning',
    })
  }
  return suppliers
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value
  const [intrinsic, argument] = Object.entries(value ?? {})[0] ?? []
  if (intrinsic?.startsWith('Fn::')) {
    const name = intrinsic.slice(4)
    const shown = Array.isArray(argument) ? argument.join('.') : typeof argument === 'string' ? argument : JSON.stringify(argument)
    return `!${name} ${shown}`
  }
  return JSON.stringify(value)
}
