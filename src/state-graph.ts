// State names and what refers to them. Each `States` object is its own namespace: a Parallel
// branch or a Map's ItemProcessor can reuse a name from the outer machine.
//
// Works on the JSON service's AST and on yaml-language-server's, which share one node shape.

export interface AstNode {
  type: string
  offset: number
  length: number
  value?: unknown
  properties?: PropertyNode[]
  items?: AstNode[]
}

interface PropertyNode {
  keyNode: AstNode
  valueNode?: AstNode
}

export interface StateScope {
  declarations: Map<string, AstNode>
  references: Array<{ name: string; node: AstNode }>
}

export interface StateTarget {
  scope: StateScope
  name: string
  node: AstNode
}

export function stateScopes(root: AstNode | undefined): StateScope[] {
  const scopes: StateScope[] = []
  const visit = (node: AstNode | undefined) => {
    if (!node) return
    if (node.type === 'object') {
      const states = property(node, 'States')
      if (states?.type === 'object') scopes.push(scopeOf(node, states))
      for (const p of node.properties ?? []) visit(p.valueNode)
    } else if (node.type === 'array') {
      for (const item of node.items ?? []) visit(item)
    }
  }
  visit(root)
  return scopes
}

function scopeOf(owner: AstNode, states: AstNode): StateScope {
  const declarations = new Map<string, AstNode>()
  const references: StateScope['references'] = []
  const refer = (node: AstNode | undefined) => {
    if (node?.type === 'string' && typeof node.value === 'string') references.push({ name: node.value, node })
  }

  refer(property(owner, 'StartAt'))
  for (const state of states.properties ?? []) {
    if (typeof state.keyNode.value === 'string') declarations.set(state.keyNode.value, state.keyNode)
    const body = state.valueNode
    if (body?.type !== 'object') continue
    refer(property(body, 'Next'))
    refer(property(body, 'Default'))
    for (const listName of ['Choices', 'Catch']) {
      for (const rule of property(body, listName)?.items ?? []) {
        if (rule.type === 'object') refer(property(rule, 'Next'))
      }
    }
  }
  return { declarations, references }
}

function property(node: AstNode, name: string): AstNode | undefined {
  return node.properties?.find((p) => p.keyNode.value === name)?.valueNode
}

export function stateAt(scopes: StateScope[], offset: number): StateTarget | undefined {
  const inside = (node: AstNode) => offset >= node.offset && offset <= node.offset + node.length
  for (const scope of scopes) {
    for (const [name, node] of scope.declarations) if (inside(node)) return { scope, name, node }
    for (const { name, node } of scope.references) if (inside(node)) return { scope, name, node }
  }
  return undefined
}

export function occurrences(target: StateTarget): Array<{ node: AstNode; declaration: boolean }> {
  const found: Array<{ node: AstNode; declaration: boolean }> = []
  const declaration = target.scope.declarations.get(target.name)
  if (declaration) found.push({ node: declaration, declaration: true })
  for (const reference of target.scope.references) {
    if (reference.name === target.name) found.push({ node: reference.node, declaration: false })
  }
  return found
}

// How a renamed state name is written where the old one was, keeping YAML's quoting style.
export function writtenName(original: string, name: string, format: 'json' | 'yaml'): string {
  if (format === 'json' || original.startsWith('"')) return JSON.stringify(name)
  if (original.startsWith("'")) return `'${name.replaceAll("'", "''")}'`
  return /^[A-Za-z0-9_][A-Za-z0-9_ .()-]*$/.test(name) && !name.endsWith(' ') ? name : JSON.stringify(name)
}
