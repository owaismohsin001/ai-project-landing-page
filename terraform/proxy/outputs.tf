output "alb_dns_name" {
  description = "Public DNS name of the edge ALB. Point *.${"platform_domain"} at this via CNAME/ALIAS in Cloudflare."
  value       = aws_lb.edge.dns_name
}

output "alb_zone_id" {
  description = "ALB hosted zone id (needed if you ever switch to Route53 ALIAS records)."
  value       = aws_lb.edge.zone_id
}

output "proxy_instance_id" {
  description = "EC2 instance id of the Traefik proxy."
  value       = aws_instance.proxy.id
}

output "proxy_public_ip" {
  description = "Public IPv4 of the Traefik proxy (for SSH / debugging)."
  value       = aws_instance.proxy.public_ip
}

output "proxy_security_group_id" {
  description = "Security group id of the proxy EC2 — pass to the workspace module so user EC2s can allow ingress from it."
  value       = aws_security_group.proxy.id
}

output "proxy_public_dns" {
  description = "Public DNS of the proxy EC2 — used as the host for the router-URL each user EC2 polls."
  value       = aws_instance.proxy.public_dns
}

output "router_base_url" {
  description = "Base URL to set as TRAEFIK_ROUTER_BASE_URL in the landing page's .env (per-user endpoint is <base>/<userId>). Stable across proxy EC2 rebuilds because it's the ALB hostname."
  value       = "http://${aws_lb.edge.dns_name}:${var.router_port}/api/traefik/user"
}

output "acm_validation_records" {
  description = "CNAME records to add in Namecheap so ACM can validate the wildcard cert. Empty list when enable_https=false."
  value = var.enable_https ? [
    for r in aws_acm_certificate.platform[0].domain_validation_options : {
      domain = r.domain_name
      # Namecheap's Host field is relative to the zone, so strip the
      # trailing dot AND the parent zone (bytescripterz.com) so the user
      # can paste it directly. The full FQDN is also shown for reference.
      record_name_fqdn = trimsuffix(r.resource_record_name, ".")
      record_value     = trimsuffix(r.resource_record_value, ".")
      record_type      = r.resource_record_type
    }
  ] : []
}

output "platform_url" {
  description = "Public scheme://host the platform is reachable on (after DNS + TLS are live)."
  value       = "${var.enable_https ? "https" : "http"}://${var.platform_domain}"
}
