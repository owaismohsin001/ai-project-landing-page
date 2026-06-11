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

variable "workspace_ami_id" {
  description = "Pre-baked workspace AMI id (built by bake.sh + `aws ec2 create-image`). Every new instance launches from this and is finalized by provision.sh — there is no fallback to a stock Ubuntu AMI on purpose, because provision.sh assumes everything bake.sh installs is already present."
  type        = string

  validation {
    condition     = can(regex("^ami-[0-9a-f]{8,17}$", var.workspace_ami_id))
    error_message = "workspace_ami_id must look like ami-xxxxxxxx (8-17 lowercase hex)."
  }
}

variable "volume_size" {
  description = "Root EBS volume size in GiB — sized by membership plan. Defaults to 40 (the workspace AMI's snapshot size); lib/workspace.ts can scale up per plan."
  type        = number
  default     = 40

  validation {
    # The pre-baked workspace AMI's root snapshot is 40 GiB; AWS will not
    # let an instance launch with volume_size < snapshot_size. 200 GiB cap
    # stops a typo from accidentally provisioning a huge disk.
    condition     = var.volume_size >= 40 && var.volume_size <= 200
    error_message = "volume_size must be between 40 and 200 GiB (40 is the workspace AMI's snapshot size)."
  }
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

variable "platform_api_url" {
  description = "Base URL of the landing-page API the workspace calls during provisioning (e.g. https://platform.bytescripterz.com). Used by provision.sh to fetch a Headscale mesh auth key from /api/workspace/mesh-authkey."
  type        = string

  validation {
    condition     = can(regex("^https?://[^/]+$", var.platform_api_url))
    error_message = "platform_api_url must be http(s)://host[:port] with no trailing path."
  }
}

variable "workspace_provision_secret" {
  description = "Shared server-to-server secret the workspace presents to /api/workspace/mesh-authkey to obtain a Headscale pre-auth key. Templated into /etc/workspace.env."
  type        = string
  sensitive   = true
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
