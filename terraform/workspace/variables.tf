variable "region" {
  description = "AWS region for the workspace."
  type        = string
}

variable "user_id" {
  description = "Stable user identifier — used to name AWS resources."
  type        = string

  validation {
    # Lowercase letters / digits / dashes, length 4-40 — fits S3 + IAM rules.
    condition     = can(regex("^[a-z0-9-]{4,40}$", var.user_id))
    error_message = "user_id must be 4-40 chars of lowercase letters, digits, or dashes."
  }
}

variable "instance_type" {
  description = "EC2 instance type — sized by membership plan."
  type        = string
}

variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
  default     = "ai-workspace"
}

variable "ingress_cidr" {
  description = "CIDR allowed to reach SSH (22) and the workspace server (9099)."
  type        = string
  default     = "0.0.0.0/0"
}

variable "platform_domain" {
  description = "Apex platform domain (e.g. platform.bytescripterz.com). Used to build the per-user HostRegexp Traefik routes to."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9.-]+$", var.platform_domain))
    error_message = "platform_domain must be a valid lowercase domain."
  }
}

variable "backend_config_url" {
  description = "URL the per-user Traefik HTTP provider polls for this user's service map (e.g. http://<proxy-dns>:9100/api/traefik/user/<user_id>). Must already include the user id — the EC2 doesn't substitute anything."
  type        = string

  validation {
    condition     = can(regex("^https?://", var.backend_config_url))
    error_message = "backend_config_url must be an absolute http(s) URL."
  }
}

variable "proxy_router_url" {
  description = "Base URL of the traefik-router on the proxy EC2 (e.g. http://<proxy-dns>:9100). The user EC2's backend uses this to register services. The user id is appended at call time, not at apply time."
  type        = string

  validation {
    condition     = can(regex("^https?://[^/]+$", var.proxy_router_url))
    error_message = "proxy_router_url must be http(s)://host[:port] with no trailing path."
  }
}

variable "config_poll_seconds" {
  description = "How often the per-user Traefik HTTP provider re-fetches dynamic config."
  type        = number
  default     = 5
}

variable "platform_protocol" {
  description = "Scheme used in service URLs (browser-facing). Set to https when the proxy's enable_https=true; http otherwise."
  type        = string
  default     = "http"

  validation {
    condition     = contains(["http", "https"], var.platform_protocol)
    error_message = "platform_protocol must be \"http\" or \"https\"."
  }
}
