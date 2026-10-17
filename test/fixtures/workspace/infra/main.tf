locals {
  shared = { region = "us-east-1" }
}

resource "aws_sfn_state_machine" "orders" {
  name     = "orders"
  role_arn = aws_iam_role.sfn.arn
  # templatefile("ignored.asl.json", {}) in a comment is not a call
  definition = templatefile("${path.module}/../statemachines/orders.asl.json.tftpl", {
    process_fn_arn = aws_lambda_function.process.arn
    timeout        = 300
    "queue-url"    = aws_sqs_queue.q.url
    retry          = { max = 3, interval = 2 }
  })
}

resource "aws_sfn_state_machine" "fanout" {
  name       = "fanout"
  role_arn   = aws_iam_role.sfn.arn
  definition = templatefile("${path.module}/../statemachines/fanout.asl.json.tftpl", {
    regions   = ["us-east-1", "us-west-2"]
    worker    = aws_lambda_function.worker.arn
    is_strict = true
  })
}
