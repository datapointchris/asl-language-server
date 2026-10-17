// Just enough HCL lexing to find where a template expression ends and which names it reads.

export interface Token {
  type: 'ident' | 'string' | 'number' | 'heredoc' | 'newline' | 'punct'
  value: string
  start: number
  end: number
  // Expression ranges of the templates nested inside a quoted string.
  templates?: Array<[number, number]>
}

export interface Reference {
  name: string
  start: number
  end: number
}

const TWO_CHAR_OPERATORS = new Set(['==', '!=', '<=', '>=', '&&', '||', '=>', '::'])
const KEYWORDS = new Set(['true', 'false', 'null', 'for', 'in', 'if', 'else', 'endif', 'endfor'])

export function isTemplateOpen(text: string, i: number): boolean {
  const c = text[i]
  return (c === '$' || c === '%') && text[i + 1] === '{'
}

export function isEscapedTemplateOpen(text: string, i: number): boolean {
  const c = text[i]
  return (c === '$' || c === '%') && text[i + 1] === c && text[i + 2] === '{'
}

// Index just past the `}` closing a template whose expression starts at `from`, or -1.
export function templateEnd(text: string, from: number, limit: number): number {
  let depth = 0
  let i = from
  while (i < limit) {
    const c = text[i]
    if (c === '"') {
      const end = quotedStringEnd(text, i + 1, limit)
      if (end === -1) return -1
      i = end
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      if (depth === 0) return i + 1
      depth--
    }
    i++
  }
  return -1
}

// Index just past the closing quote of an HCL quoted template, or -1 when the line ends first.
function quotedStringEnd(text: string, from: number, limit: number, templates?: Array<[number, number]>): number {
  let i = from
  while (i < limit) {
    const c = text[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '\n') return -1
    if (c === '"') return i + 1
    if (isEscapedTemplateOpen(text, i)) {
      i += 3
      continue
    }
    if (isTemplateOpen(text, i)) {
      const end = templateEnd(text, i + 2, limit)
      if (end === -1) return -1
      templates?.push([i + 2, end - 1])
      i = end
      continue
    }
    i++
  }
  return -1
}

function isIdentStart(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z_]/.test(c)
}

function isIdentPart(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_-]/.test(c)
}

export function tokenize(text: string, start = 0, end = text.length): Token[] {
  const tokens: Token[] = []
  let i = start
  while (i < end) {
    const c = text[i]
    if (c === '\n') {
      tokens.push({ type: 'newline', value: '\n', start: i, end: i + 1 })
      i++
    } else if (c === ' ' || c === '\t' || c === '\r') {
      i++
    } else if (c === '#' || (c === '/' && text[i + 1] === '/')) {
      while (i < end && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      i = close === -1 || close >= end ? end : close + 2
    } else if (c === '"') {
      const templates: Array<[number, number]> = []
      const close = quotedStringEnd(text, i + 1, end, templates)
      const stop = close === -1 ? lineEnd(text, i, end) : close
      tokens.push({ type: 'string', value: text.slice(i, stop), start: i, end: stop, templates })
      i = stop
    } else if (c === '<' && text[i + 1] === '<' && /[-A-Za-z_]/.test(text[i + 2] ?? '')) {
      const stop = heredocEnd(text, i, end)
      tokens.push({ type: 'heredoc', value: text.slice(i, stop), start: i, end: stop })
      i = stop
    } else if (isIdentStart(c)) {
      let j = i + 1
      while (j < end && isIdentPart(text[j])) j++
      tokens.push({ type: 'ident', value: text.slice(i, j), start: i, end: j })
      i = j
    } else if (/[0-9]/.test(c)) {
      const match = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, end))
      const j = i + (match?.[0].length ?? 1)
      tokens.push({ type: 'number', value: text.slice(i, j), start: i, end: j })
      i = j
    } else {
      const pair = text.slice(i, i + 2)
      const width = TWO_CHAR_OPERATORS.has(pair) ? 2 : pair === '..' && text[i + 2] === '.' ? 3 : 1
      tokens.push({ type: 'punct', value: text.slice(i, i + width), start: i, end: i + width })
      i += width
    }
  }
  return tokens
}

function lineEnd(text: string, from: number, limit: number): number {
  const newline = text.indexOf('\n', from)
  return newline === -1 || newline > limit ? limit : newline
}

function heredocEnd(text: string, start: number, limit: number): number {
  const header = /^<<-?([A-Za-z_][A-Za-z0-9_-]*)/.exec(text.slice(start, limit))
  if (!header) return start + 2
  const marker = header[1]
  let line = lineEnd(text, start, limit) + 1
  while (line < limit) {
    const stop = lineEnd(text, line, limit)
    if (text.slice(line, stop).trim() === marker) return stop
    line = stop + 1
  }
  return limit
}

// Names an expression reads from its scope: not attributes, functions, object keys or its own `for` bindings.
export function references(text: string, start: number, end: number): Reference[] {
  const tokens = tokenize(text, start, end).filter((t) => t.type !== 'newline')
  const bound = new Set<string>()
  const found: Reference[] = []
  tokens.forEach((token, index) => {
    if (token.type === 'string') {
      for (const [from, to] of token.templates ?? []) found.push(...references(text, from, to))
      return
    }
    if (token.type !== 'ident') return
    const previous = tokens[index - 1]?.value
    const next = tokens[index + 1]?.value
    if (token.value === 'for') {
      for (let j = index + 1; j < tokens.length && tokens[j].value !== 'in'; j++) {
        if (tokens[j].type === 'ident') bound.add(tokens[j].value)
      }
      return
    }
    if (KEYWORDS.has(token.value) || bound.has(token.value)) return
    if (previous === '.' || previous === '::' || next === '::' || next === '(' || next === '=') return
    if (next === ':' && (previous === '{' || previous === ',')) return
    found.push({ name: token.value, start: token.start, end: token.end })
  })
  return found.filter((reference) => !bound.has(reference.name))
}
