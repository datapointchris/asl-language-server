import path from 'node:path'
import { tokenize, type Token } from '../template-syntax/hcl.ts'
import type { Supplier, SuppliedVariable } from './supplier.ts'

export interface TemplatefileCall {
  start: number
  pathExpression: string
  pathString: string | undefined
  // Undefined when the second argument is not an object literal, so its keys are unknowable.
  variables: Array<{ name: string; start: number; end: number; value: string }> | undefined
  variablesExpression: string
}

export function templatefileCalls(hcl: string): TemplatefileCall[] {
  const tokens = tokenize(hcl)
  const calls: TemplatefileCall[] = []
  tokens.forEach((token, index) => {
    if (token.type !== 'ident' || token.value !== 'templatefile') return
    if (tokens[index + 1]?.value !== '(' || tokens[index - 1]?.value === '.') return
    const args = splitArguments(tokens, index + 2)
    if (args.length === 0) return
    const [pathTokens, variableTokens = []] = args
    // Only a bare string is a path. Inside format() or abspath() a string is an argument whose meaning depends on the call.
    const bareString = pathTokens.length === 1 && pathTokens[0].type === 'string'
    calls.push({
      start: token.start,
      pathExpression: source(hcl, pathTokens),
      pathString: bareString ? pathTokens[0].value.slice(1, -1) : undefined,
      variables: objectEntries(hcl, variableTokens),
      variablesExpression: source(hcl, variableTokens),
    })
  })
  return calls
}

function source(hcl: string, tokens: Token[]): string {
  return tokens.length === 0 ? '' : hcl.slice(tokens[0].start, tokens[tokens.length - 1].end)
}

function splitArguments(tokens: Token[], from: number): Token[][] {
  const args: Token[][] = [[]]
  let depth = 0
  for (let i = from; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === 'punct' && '([{'.includes(token.value)) depth++
    if (token.type === 'punct' && ')]}'.includes(token.value)) {
      if (depth === 0) return args.map((arg) => trimNewlines(arg)).filter((arg) => arg.length > 0)
      depth--
    }
    if (depth === 0 && token.value === ',') args.push([])
    else args[args.length - 1].push(token)
  }
  return []
}

function trimNewlines(tokens: Token[]): Token[] {
  let start = 0
  let end = tokens.length
  while (start < end && tokens[start].type === 'newline') start++
  while (end > start && tokens[end - 1].type === 'newline') end--
  return tokens.slice(start, end)
}

function objectEntries(hcl: string, tokens: Token[]): TemplatefileCall['variables'] {
  if (tokens[0]?.value !== '{' || tokens[tokens.length - 1]?.value !== '}') return undefined
  const entries: NonNullable<TemplatefileCall['variables']> = []
  let depth = 0
  let entryStart = true
  for (let i = 1; i < tokens.length - 1; i++) {
    const token = tokens[i]
    if (depth === 0 && (token.type === 'newline' || token.value === ',')) {
      entryStart = true
      continue
    }
    if (entryStart && depth === 0 && (token.type === 'ident' || token.type === 'string')) {
      const separator = tokens[i + 1]?.value
      if (separator === '=' || separator === ':') {
        const name = token.type === 'string' ? token.value.slice(1, -1) : token.value
        let j = i + 2
        let valueDepth = 0
        while (j < tokens.length - 1) {
          const t = tokens[j]
          if (valueDepth === 0 && (t.type === 'newline' || t.value === ',')) break
          if (t.type === 'punct' && '([{'.includes(t.value)) valueDepth++
          if (t.type === 'punct' && ')]}'.includes(t.value)) valueDepth--
          j++
        }
        entries.push({ name, start: token.start, end: token.end, value: source(hcl, tokens.slice(i + 2, j)) })
      }
    }
    entryStart = false
    if (token.type === 'punct' && '([{'.includes(token.value)) depth++
    if (token.type === 'punct' && ')]}'.includes(token.value)) depth--
  }
  return entries
}

const MODULE_PATHS = /\$\{\s*path\.(module|root|cwd)\s*\}/g

// A pattern for the files a templatefile() path argument can name. `path.root` and `path.cwd`
// are read as the calling file's directory, which is right for a root module and the common
// case. Any other interpolation matches one path segment, so a `for_each` over templates still
// finds its file.
export function pathPattern(pathString: string, callerDirectory: string): RegExp {
  const placeholder = '\u0000'
  let candidate = pathString.replace(MODULE_PATHS, () => callerDirectory).replace(/\$\{[^}]*\}/g, placeholder)
  if (!path.isAbsolute(candidate)) candidate = path.join(callerDirectory, candidate)
  const normalized = path.normalize(candidate)
  const escaped = normalized
    .split(placeholder)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+')
  return new RegExp(`^${escaped}$`)
}

export function terraformSuppliers(hcl: string, callerPath: string, documentPath: string): Supplier[] {
  const callerDirectory = path.dirname(callerPath)
  const lineStarts = lineOffsets(hcl)
  const suppliers: Supplier[] = []
  for (const call of templatefileCalls(hcl)) {
    const exact = call.pathString !== undefined && pathPattern(call.pathString, callerDirectory).test(documentPath)
    const byName = call.pathString === undefined && call.pathExpression.includes(path.basename(documentPath))
    if (!exact && !byName) continue
    const variables = call.variables?.map((entry): SuppliedVariable => ({
      name: entry.name,
      value: entry.value,
      file: callerPath,
      position: positionAt(lineStarts, entry.start),
      endPosition: positionAt(lineStarts, entry.end),
    }))
    suppliers.push({
      kind: 'terraform',
      file: callerPath,
      position: positionAt(lineStarts, call.start),
      variables,
      variablesExpression: call.variablesExpression,
      matchedBy: exact ? 'path' : 'filename',
      unknownIs: 'error',
    })
  }
  return suppliers
}

export function lineOffsets(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

export function positionAt(lineStarts: number[], offset: number): { line: number; character: number } {
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (lineStarts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return { line: low, character: offset - lineStarts[low] }
}
