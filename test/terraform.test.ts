import { expect, test } from 'vitest'
import { terraformSuppliers } from '../src/substitution-sources/terraform.ts'

test('templatefile() calls are matched by resolved path, including a for_each over interpolated file names', () => {
  const hcl = `
# templatefile("\${path.module}/sfn/orders.asl.json", { commented = true })
resource "aws_sfn_state_machine" "each" {
  for_each   = toset(["orders", "refunds"])
  definition = templatefile("\${path.module}/sfn/\${each.key}.asl.json", {
    "queue-url" = aws_sqs_queue.q[each.key].url
    retry       = { max = 3, interval = 2 }
    names       = [for n in local.names : upper(n)]
  })
}
resource "aws_sfn_state_machine" "other" {
  definition = templatefile("\${path.module}/../elsewhere/orders.asl.json", { unrelated = 1 })
}
locals {
  vars = { a = 1 }
  indirect = templatefile(local.template_path, local.vars)
}
`
  const suppliers = terraformSuppliers(hcl, '/repo/infra/main.tf', '/repo/infra/sfn/orders.asl.json')

  expect(suppliers.map((s) => [s.matchedBy, s.variables?.map((v) => v.name)])).toEqual([['path', ['queue-url', 'retry', 'names']]])
  expect(suppliers[0].variables?.[1].value).toBe('{ max = 3, interval = 2 }')
  expect(suppliers[0].position.line).toBe(4)
})
