output "instance_id" {
  description = "EC2 instance id of the workspace."
  value       = aws_instance.workspace.id
}

output "instance_public_ip" {
  description = "Public IPv4 address of the workspace EC2."
  value       = aws_instance.workspace.public_ip
}

output "instance_public_dns" {
  description = "Public DNS name of the workspace EC2."
  value       = aws_instance.workspace.public_dns
}

output "bucket_name" {
  description = "Workspace S3 bucket name."
  value       = aws_s3_bucket.workspace.bucket
}

output "security_group_id" {
  description = "Workspace security group id."
  value       = aws_security_group.workspace.id
}

output "iam_user_name" {
  description = "Workspace IAM user name."
  value       = aws_iam_user.workspace.name
}

output "iam_access_key_id" {
  description = "Access key id for the workspace IAM user."
  value       = aws_iam_access_key.workspace.id
  sensitive   = true
}

output "iam_secret_access_key" {
  description = "Secret access key for the workspace IAM user."
  value       = aws_iam_access_key.workspace.secret
  sensitive   = true
}

output "public_host_suffix" {
  description = "Per-user subdomain suffix (<user_id>.<platform_domain>). Service URLs are http://<service>-<user_id>.<platform_domain>/."
  value       = "${var.user_id}.${var.platform_domain}"
}

output "workspace_url" {
  description = "User-facing frontend URL routed through the edge ALB + Traefik."
  value       = "${var.platform_protocol}://frontend-${var.user_id}.${var.platform_domain}"
}

output "workspace_api_url" {
  description = "Internal control-plane URL of the workspace HTTP server (port 9099) — backup/restore. Hits the EC2 directly, not via Traefik."
  value       = "http://${aws_instance.workspace.public_dns}:9099"
}
