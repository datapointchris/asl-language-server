import { ClientCapabilities, getLanguageService } from 'amazon-states-language-service'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { expect, test } from 'vitest'
import { analyze } from '../src/document-analysis.ts'
import { occurrences, stateAt } from '../src/state-graph.ts'

test('a state name resolves inside its own States object, so a Parallel branch can reuse an outer name', () => {
  const text = JSON.stringify(
    {
      StartAt: 'Work',
      States: {
        Work: {
          Type: 'Parallel',
          Branches: [{ StartAt: 'Work', States: { Work: { Type: 'Pass', Next: 'Done' }, Done: { Type: 'Succeed' } } }],
          Catch: [{ ErrorEquals: ['States.ALL'], Next: 'Done' }],
          Next: 'Done',
        },
        Done: { Type: 'Succeed' },
      },
    },
    null,
    2,
  )
  const document = TextDocument.create('file:///machine.asl.json', 'asl', 1, text)
  const { scopes } = analyze(document, getLanguageService({ clientCapabilities: ClientCapabilities.LATEST }))
  const lineOf = (offset: number) => document.positionAt(offset).line + 1
  const linesFor = (needle: string, nth = 0) => {
    let offset = -1
    for (let i = 0; i <= nth; i++) offset = text.indexOf(needle, offset + 1)
    const target = stateAt(scopes, offset + needle.length - 2)
    return target ? occurrences(target).map(({ node }) => lineOf(node.offset)) : []
  }

  // From the Parallel's Next: the outer Done's declaration, that Next, and the Catch. Not the branch's Done.
  expect(linesFor('"Next": "Done"', 2)).toEqual([30, 28, 25])
  expect(linesFor('"Next": "Done"', 0)).toEqual([14, 12])
  expect(linesFor('"StartAt": "Work"', 1)).toEqual([10, 8])
})
