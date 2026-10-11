-- 007_resource_types_sns: SNS topics get a name and icon. The code scanner already follows
-- sns:Publish calls and both Terraform and CloudFormation can declare topics.

INSERT INTO resource_types (terraform_type, service, display_name, category, icon_key, color, sort_order) VALUES
  ('aws_sns_topic', 'SNS', 'SNS Topic', 'messaging', 'aws/sns', '#E7157B', 42)
ON CONFLICT (terraform_type) DO NOTHING;
