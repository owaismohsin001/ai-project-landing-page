variable "region" {
  description = "AWS region for the Headscale control server."
  type        = string
}

variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
  default     = "ai-headscale"
}

variable "instance_type" {
  description = "EC2 type for the Headscale control server. t3.small is plenty — it only carries control traffic + DERP relay."
  type        = string
  default     = "t3.small"
}

variable "platform_domain" {
  description = "Apex platform domain (e.g. platform.bytescripterz.com). The control server and MagicDNS suffix are subdomains of this."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9.-]+$", var.platform_domain))
    error_message = "platform_domain must be a valid lowercase domain."
  }
}

variable "headscale_subdomain" {
  description = "Subdomain label for the control server. Final URL is https://<sub>.<platform_domain> UNLESS server_fqdn overrides it. A manual A record for the resulting host -> the EIP is required for Let's Encrypt."
  type        = string
  default     = "headscale"
}

variable "server_fqdn" {
  description = "Optional explicit control-plane hostname, overriding <headscale_subdomain>.<platform_domain>. Set to a host OUTSIDE any wildcard (e.g. headscale.bytescripterz.com, since *.platform.bytescripterz.com is a wildcard to the proxy ALB)."
  type        = string
  default     = ""
}

variable "magic_dns_subdomain" {
  description = "Subdomain label for the MagicDNS base domain. MUST differ from headscale_subdomain so Headscale's base_domain is not a parent of its own server_url. Nodes get <hostname>.<this>.<platform_domain>."
  type        = string
  default     = "ts"
}

variable "headscale_version" {
  description = "Headscale release to install (matches the .deb published on github.com/juanfont/headscale/releases)."
  type        = string
  default     = "0.23.0"
}

variable "api_key_ssm_param" {
  description = "SSM Parameter Store name where the bootstrap writes the Headscale API key (SecureString). The landing page reads this into HEADSCALE_API_KEY."
  type        = string
  default     = "/platform/headscale/api-key"
}

variable "ingress_cidr" {
  description = "CIDR allowed to reach the control server / DERP. Must stay open to the internet so NAT'd desktops can register and relay."
  type        = string
  default     = "0.0.0.0/0"
}
