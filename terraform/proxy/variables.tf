variable "region" {
  description = "AWS region for the proxy + ALB."
  type        = string
}

variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
  default     = "ai-proxy"
}

variable "instance_type" {
  description = "EC2 type for the central Traefik proxy."
  type        = string
  default     = "t3.small"
}

variable "platform_domain" {
  description = "Apex platform domain Traefik routes under (e.g. platform.bytescripterz.com)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9.-]+$", var.platform_domain))
    error_message = "platform_domain must be a valid lowercase domain."
  }
}

variable "config_poll_seconds" {
  description = "How often the Traefik HTTP provider re-fetches dynamic config."
  type        = number
  default     = 5
}

variable "router_port" {
  description = "Port the in-box traefik-router Node service listens on. Traefik on this box and on every user EC2 polls it."
  type        = number
  default     = 9100
}

variable "mongodb_uri" {
  description = "MongoDB connection string the traefik-router uses to query the same DB as the landing page."
  type        = string
  sensitive   = true
}

variable "ingress_cidr" {
  description = "CIDR allowed to reach the ALB. Default 0.0.0.0/0 since the proxy is the public entrypoint."
  type        = string
  default     = "0.0.0.0/0"
}

variable "enable_https" {
  description = "When true, request an ACM wildcard cert + add an HTTPS listener on the ALB, and redirect HTTP→HTTPS. Requires adding the ACM validation CNAME(s) in Namecheap (see terraform output acm_validation_records)."
  type        = bool
  default     = false
}
