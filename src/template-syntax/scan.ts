// Terraform's templatefile() and SAM's DefinitionSubstitutions both write `${...}` into the
// definition, and Terraform adds `%{...}` directives. The ASL service only parses JSON or YAML,
// so every span is overwritten with text that parses, at the same length and with every newline
// kept, so an offset in the masked text is the same offset in the file.

import { isEscapedTemplateOpen, isTemplateOpen, references, templateEnd, type Reference } from './hcl.ts'

export type Format = 'json' | 'yaml'

// Where a span sits in the JSON around it, which decides what it is masked with.
export type Slot = 'string' | 'key' | 'value' | 'after-value' | 'colon'

export type DirectiveKeyword = 'if' | 'else' | 'endif' | 'for' | 'endfor' | 'unknown'

interface SpanBase {
  start: number
  end: number
  expressionStart: number
  expressionEnd: number
  closed: boolean
  references: Reference[]
}

export interface Interpolation extends SpanBase {
  kind: 'interpolation'
  slot: Slot
}

export interface Directive extends SpanBase {
  kind: 'directive'
  keyword: DirectiveKeyword
}

// The text between `%{ else }` and `%{ endif }`. Only the `if` branch is validated, so a
// template writing a different value in each branch is not read as both at once.
export interface SkippedBranch {
  kind: 'skipped'
  start: number
  end: number
}

export type Span = Interpolation | Directive | SkippedBranch

export interface LoopScope {
  bindings: Reference[]
  start: number
  end: number
}

export interface ScannedTemplate {
  masked: string
  spans: Span[]
  loops: LoopScope[]
}

const FOR_HEADER = /^(\s*for\s+)([A-Za-z_][\w-]*)(\s*,\s*([A-Za-z_][\w-]*))?\s+in\s/

export function scanTemplate(text: string, format: Format): ScannedTemplate {
  const out = text.split('')
  const spans: Span[] = []
  const loops: LoopScope[] = []
  const containers: Array<'object' | 'array'> = []
  const conditionals: number[] = []
  const openLoops: Array<{ bindings: Reference[]; start: number }> = []
  let slot: Exclude<Slot, 'string'> = 'value'
  let inString = false
  let stringIsKey = false
  let skipFrom = -1
  let skipDepth = -1

  const fill = (from: number, to: number, replacement: string) => {
    for (let k = from, r = 0; k < to; k++) {
      if (out[k] === '\n' || out[k] === '\r') continue
      out[k] = r < replacement.length ? replacement[r++] : replacement === 'x' ? 'x' : ' '
    }
  }

  let i = 0
  while (i < text.length) {
    if (isEscapedTemplateOpen(text, i)) {
      if (skipDepth !== -1) fill(i, i + 3, ' ')
      i += 3
      continue
    }

    if (isTemplateOpen(text, i)) {
      const lineStop = indexOrEnd(text, '\n', i)
      const inJsonString = format === 'json' && inString
      const close = templateEnd(text, i + 2, inJsonString ? lineStop : text.length)
      const closed = close !== -1
      const end = closed ? close : inJsonString ? indexOrEnd(text, '"', i, lineStop) : lineStop
      const expressionStart = text[i + 2] === '~' ? i + 3 : i + 2
      const expressionEnd = closed ? (text[end - 2] === '~' ? end - 2 : end - 1) : end

      if (text[i] === '$') {
        spans.push({
          kind: 'interpolation',
          start: i,
          end,
          expressionStart,
          expressionEnd,
          closed,
          slot: inString ? 'string' : slot,
          references: references(text, expressionStart, expressionEnd),
        })
        if (skipDepth !== -1) fill(i, end, ' ')
        else if (format === 'yaml' || inString) fill(i, end, 'x')
        else if (slot === 'value') {
          fill(i, end, '0')
          slot = 'after-value'
        } else if (slot === 'key' && end - i >= 4) {
          fill(i, end, '"":0')
          slot = 'after-value'
        } else fill(i, end, ' ')
      } else {
        const expression = text.slice(expressionStart, expressionEnd)
        const keyword = directiveKeyword(expression)
        const directive: Directive = {
          kind: 'directive',
          start: i,
          end,
          expressionStart,
          expressionEnd,
          closed,
          keyword,
          references: [],
        }
        spans.push(directive)
        fill(i, end, ' ')

        if (keyword === 'if') {
          conditionals.push(i)
          directive.references = references(text, expressionStart + expression.indexOf('if') + 2, expressionEnd)
        } else if (keyword === 'else' && skipDepth === -1 && conditionals.length > 0) {
          skipDepth = conditionals.length
          skipFrom = end
        } else if (keyword === 'endif') {
          if (skipDepth === conditionals.length) {
            spans.push({ kind: 'skipped', start: skipFrom, end: i })
            skipDepth = -1
          }
          conditionals.pop()
        } else if (keyword === 'for') {
          const header = FOR_HEADER.exec(expression)
          const bindings: Reference[] = []
          if (header) {
            const first = expressionStart + header[1].length
            bindings.push({ name: header[2], start: first, end: first + header[2].length })
            if (header[4]) {
              const second = expressionStart + header[0].lastIndexOf(header[4])
              bindings.push({ name: header[4], start: second, end: second + header[4].length })
            }
            directive.references = references(text, expressionStart + header[0].length, expressionEnd)
          }
          openLoops.push({ bindings, start: end })
        } else if (keyword === 'endfor') {
          const loop = openLoops.pop()
          if (loop) loops.push({ bindings: loop.bindings, start: loop.start, end: i })
        }
      }
      i = end
      continue
    }

    const c = text[i]
    if (skipDepth !== -1) {
      if (c !== '\n' && c !== '\r') out[i] = ' '
      i++
      continue
    }
    if (format === 'yaml') {
      i++
      continue
    }

    if (inString) {
      if (c === '\\') i += isTemplateOpen(text, i + 1) ? 1 : 2
      else {
        if (c === '"') {
          inString = false
          slot = stringIsKey ? 'colon' : 'after-value'
        }
        i++
      }
      continue
    }

    if (c === '"') {
      inString = true
      stringIsKey = slot === 'key'
    } else if (c === '{') {
      containers.push('object')
      slot = 'key'
    } else if (c === '[') {
      containers.push('array')
      slot = 'value'
    } else if (c === '}' || c === ']') {
      containers.pop()
      slot = 'after-value'
    } else if (c === ':') slot = 'value'
    else if (c === ',') slot = containers.at(-1) === 'object' ? 'key' : 'value'
    else if (!/\s/.test(c)) slot = 'after-value'
    i++
  }

  return { masked: out.join(''), spans, loops }
}

function directiveKeyword(expression: string): DirectiveKeyword {
  const word = /^\s*([a-z]+)/.exec(expression)?.[1]
  return word === 'if' || word === 'else' || word === 'endif' || word === 'for' || word === 'endfor' ? word : 'unknown'
}

function indexOrEnd(text: string, needle: string, from: number, limit = text.length): number {
  const found = text.indexOf(needle, from + 2)
  return found === -1 || found > limit ? limit : found
}

export function spanAt(spans: Span[], offset: number): Span | undefined {
  return spans.find((span) => span.kind !== 'skipped' && offset >= span.start && offset <= span.end)
}

export function overlapsSpan(spans: Span[], start: number, end: number): boolean {
  return spans.some((span) => (start === end ? start > span.start && start < span.end : start < span.end && span.start < end))
}
