output "headscale_eip" {
  description = "Elastic IP of the Headscale control server. Add a manual A record `${"headscale_subdomain"}.${"platform_domain"}` -> this in Namecheap/Cloudflare BEFORE Let's Encrypt can issue the cert."
  value       = aws_eip.headscale.public_ip
}

output "headscale_url" {
  description = "Control-plane URL. Set as HEADSCALE_URL in the landing page env. Nodes register against this with `tailscale up --login-server=<this>`."
  value       = local.server_url
}

output "headscale_server_host" {
  description = "Hostname that needs the public A record -> headscale_eip."
  value       = local.server_host
}

output "magic_dns_suffix" {
  description = "MagicDNS base domain. Set as HEADSCALE_MAGIC_DNS_SUFFIX in the landing page env (defaults match this). Nodes resolve as <hostname>.<this>."
  value       = local.base_domain
}

output "api_key_ssm_param" {
  description = "SSM Parameter Store name holding the Headscale API key (SecureString). Read it into HEADSCALE_API_KEY: aws ssm get-parameter --with-decryption --name <this>."
  value       = var.api_key_ssm_param
}

output "instance_id" {
  description = "EC2 instance id of the Headscale control server (for SSM/SSH)."
  value       = aws_instance.headscale.id
}
