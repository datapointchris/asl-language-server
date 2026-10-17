// A supplier is whatever fills a definition's `${...}`: a templatefile() call or a SAM state machine.

export interface Position {
  line: number
  character: number
}

export interface SuppliedVariable {
  name: string
  value: string
  file: string
  position: Position
  endPosition: Position
}

export interface Supplier {
  kind: 'terraform' | 'sam'
  file: string
  position: Position
  // Undefined when the supplier passes something whose keys cannot be read, such as `local.vars`.
  variables: SuppliedVariable[] | undefined
  variablesExpression: string
  // `filename` means the path argument was not a plain string and only the file's name matched it.
  matchedBy: 'path' | 'filename'
  // Terraform fails the plan on a missing key; SAM leaves `${Name}` in the definition as literal text.
  unknownIs: 'error' | 'warning'
}
