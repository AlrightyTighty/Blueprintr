resource "aws_dynamodb_table" "orders" {
  name         = "orders-${var.env}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_s3_bucket" "uploads" {
  bucket = "ripplemap-uploads-${var.env}"
}

resource "aws_s3_bucket" "site" {
  bucket = "ripplemap-site-${var.env}"
}

resource "aws_sqs_queue" "jobs" {
  name = "jobs-${var.env}"
}

resource "aws_iam_role" "api_role" {
  name = "api-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

# Planted trap: s3:* on everything, while the code only writes one bucket.
resource "aws_iam_role_policy" "api_access" {
  name = "api-access"
  role = aws_iam_role.api_role.id
  # Planted trap: the code also calls dynamodb:DeleteItem, which is not allowed here.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]
        Resource = [aws_dynamodb_table.orders.arn, "${aws_dynamodb_table.orders.arn}/index/*"]
      },
      {
        Effect   = "Allow"
        Action   = "s3:*"
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.jobs.arn
      }
    ]
  })
}

resource "aws_iam_role" "worker_role" {
  name = "worker-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

data "aws_iam_policy_document" "worker" {
  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage"]
    resources = [aws_sqs_queue.jobs.arn]
  }
  statement {
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.orders.arn]
  }
}

resource "aws_iam_policy" "worker" {
  name   = "worker"
  policy = data.aws_iam_policy_document.worker.json
}

resource "aws_iam_role_policy_attachment" "worker" {
  role       = aws_iam_role.worker_role.name
  policy_arn = aws_iam_policy.worker.arn
}

data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../src/api"
  output_path = "${path.module}/api.zip"
}

resource "aws_lambda_function" "api" {
  function_name = "api-${var.env}"
  role          = aws_iam_role.api_role.arn
  runtime       = "nodejs20.x"
  handler       = "app.handler"
  filename      = data.archive_file.api.output_path

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.orders.name
      BUCKET     = aws_s3_bucket.uploads.bucket
      QUEUE_URL  = aws_sqs_queue.jobs.url
    }
  }
}

data "archive_file" "worker" {
  type        = "zip"
  source_dir  = "${path.module}/../src/worker"
  output_path = "${path.module}/worker.zip"
}

resource "aws_lambda_function" "worker" {
  function_name = "worker-${var.env}"
  role          = aws_iam_role.worker_role.arn
  runtime       = "python3.12"
  handler       = "main.handler"
  filename      = data.archive_file.worker.output_path

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.orders.name
      QUEUE_URL  = aws_sqs_queue.jobs.url
    }
  }
}

resource "aws_lambda_event_source_mapping" "jobs" {
  event_source_arn = aws_sqs_queue.jobs.arn
  function_name    = aws_lambda_function.worker.arn
}

resource "aws_apigatewayv2_api" "http" {
  name          = "ripplemap-http"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "api" {
  api_id           = aws_apigatewayv2_api.http.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.api.invoke_arn
}

resource "aws_cloudfront_distribution" "site" {
  enabled = true
  aliases = [var.domain]

  origin {
    domain_name = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id   = "site"
  }
}

resource "aws_route53_record" "site" {
  zone_id = "Z123"
  name    = var.domain
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
