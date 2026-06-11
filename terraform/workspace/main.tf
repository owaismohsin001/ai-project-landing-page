provider "aws" {
  region = var.region
}

locals {
  resource_name = "${var.name_prefix}-${var.user_id}"

  tags = {
    Workspace = var.user_id
    ManagedBy = "terraform"
    App       = var.name_prefix
  }
}

# Workspace AMI is now a pre-baked image (bake.sh + snapshot). Pinned
# explicitly via var.workspace_ami_id so a wrong stock Ubuntu AMI can
# never accidentally provision an unbaked instance — provision.sh hard-
# fails if /etc/ai-ide-ami-version is missing.

# ─── S3 bucket ────────────────────────────────────────────────────────
resource "aws_s3_bucket" "workspace" {
  bucket        = local.resource_name
  force_destroy = true

  tags = merge(local.tags, { Name = local.resource_name })
}

resource "aws_s3_bucket_public_access_block" "workspace" {
  bucket                  = aws_s3_bucket.workspace.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "workspace" {
  bucket = aws_s3_bucket.workspace.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ─── Security group ───────────────────────────────────────────────────
# ⚠ SECURITY WARNING
#   This SG allows ALL ingress on ALL ports (TCP + UDP + ICMP + ...) from
#   var.ingress_cidr. With the default ingress_cidr of 0.0.0.0/0, every
#   service on this instance — including code-server (no auth = root shell)
#   and the workspace backup/restore API — is reachable from the entire
#   internet. Set var.ingress_cidr to your own IP whenever practical.
resource "aws_security_group" "workspace" {
  name        = "${local.resource_name}-sg"
  description = "Workspace ${var.user_id} - all ports open to var.ingress_cidr"

  ingress {
    description = "All ingress (all protocols, all ports)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.ingress_cidr]
  }

  egress {
    description = "All egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

# ─── IAM user + access key ────────────────────────────────────────────
resource "aws_iam_user" "workspace" {
  name = local.resource_name
  tags = local.tags
}

resource "aws_iam_access_key" "workspace" {
  user = aws_iam_user.workspace.name
}

# ─── EC2 instance ─────────────────────────────────────────────────────
locals {
  # Per-user Traefik static config. Dynamic routes come from the HTTP
  # provider — this file only wires entrypoints + the poll URL.
  traefik_yml = templatefile("${path.module}/traefik.yml.tftpl", {
    backend_config_url  = var.backend_config_url
    config_poll_seconds = var.config_poll_seconds
  })

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    server_js_b64gz  = base64gzip(file("${path.module}/server/server.js"))
    package_json_b64 = base64encode(file("${path.module}/server/package.json"))
    # cloud-init.sh used to be base64-embedded here, but it grew past
    # what fits in AWS's 16KB user-data limit. The proxy EC2 hosts it now
    # at ${proxy_router_url}/bootstrap/cloud-init.sh, and user-data.sh
    # curls it down at boot. cloud-init.sh lives in this module so it
    # stays version-controlled with the workspace it bootstraps.
    traefik_yml_b64            = base64encode(local.traefik_yml)
    bucket_id                  = aws_s3_bucket.workspace.bucket
    region                     = var.region
    access_key_id              = aws_iam_access_key.workspace.id
    secret_access_key          = aws_iam_access_key.workspace.secret
    user_id                    = var.user_id
    platform_domain            = var.platform_domain
    platform_protocol          = var.platform_protocol
    proxy_router_url           = var.proxy_router_url
    platform_api_url           = var.platform_api_url
    workspace_provision_secret = var.workspace_provision_secret
  })
}

resource "aws_instance" "workspace" {
  ami                         = var.workspace_ami_id
  instance_type               = var.instance_type
  vpc_security_group_ids      = [aws_security_group.workspace.id]
  associate_public_ip_address = true
  # AWS caps user-data at 16 KB. The wrapper + base64-embedded server.js +
  # package.json + cloud-init.sh add up to ~28 KB raw, so we gzip-compress
  # and ship via user_data_base64. cloud-init auto-decompresses on boot.
  user_data_base64            = base64gzip(local.user_data)
  user_data_replace_on_change = true

  metadata_options {
    http_tokens                 = "optional"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_size           = var.volume_size
    volume_type           = "gp3"
    delete_on_termination = true

    tags = local.tags
  }

  tags = merge(local.tags, { Name = local.resource_name })
}

# ─── IAM policy ───────────────────────────────────────────────────────
# Attached after the instance exists so we can scope it to the real
# instance / security-group / bucket ARNs.
resource "aws_iam_user_policy" "workspace" {
  name = "workspace-permissions"
  user = aws_iam_user.workspace.name

  policy = templatefile("${path.module}/iam-policy.json.tpl", {
    region            = var.region
    instance_id       = aws_instance.workspace.id
    security_group_id = aws_security_group.workspace.id
    bucket_name       = aws_s3_bucket.workspace.bucket
  })
}
