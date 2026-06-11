provider "aws" {
  region = var.region
}

locals {
  resource_name = var.name_prefix
  server_host   = var.server_fqdn != "" ? var.server_fqdn : "${var.headscale_subdomain}.${var.platform_domain}"
  server_url    = "https://${local.server_host}"
  base_domain   = "${var.magic_dns_subdomain}.${var.platform_domain}"

  tags = {
    ManagedBy = "terraform"
    App       = var.name_prefix
    Role      = "headscale-control"
  }
}

# ─── Network ───────────────────────────────────────────────────────────
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ─── Security group ────────────────────────────────────────────────────
# Headscale must be directly internet-reachable (no ALB): the control stream,
# the embedded DERP relay (over :443) and STUN (udp/3478) all need a clean
# public endpoint, and Let's Encrypt HTTP-01 needs :80.
resource "aws_security_group" "headscale" {
  name        = "${local.resource_name}-sg"
  description = "Self-hosted Headscale control server + embedded DERP."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "Headscale control + DERP (HTTPS)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.ingress_cidr]
  }

  ingress {
    description = "LetsEncrypt HTTP-01 challenge"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.ingress_cidr]
  }

  ingress {
    description = "DERP STUN"
    from_port   = 3478
    to_port     = 3478
    protocol    = "udp"
    cidr_blocks = [var.ingress_cidr]
  }

  ingress {
    description = "SSH (ops)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ingress_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${local.resource_name}-sg" })
}

# ─── IAM (SSM access + write the API key to Parameter Store) ───────────
resource "aws_iam_role" "headscale" {
  name = "${local.resource_name}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "ec2.amazonaws.com" }
        Action    = "sts:AssumeRole"
      },
    ]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "headscale_ssm" {
  role       = aws_iam_role.headscale.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Write the bootstrap-minted Headscale API key into SSM Parameter Store as a
# SecureString. The landing page reads it into HEADSCALE_API_KEY.
resource "aws_iam_role_policy" "headscale_put_param" {
  name = "${local.resource_name}-put-api-key"
  role = aws_iam_role.headscale.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:PutParameter"]
        Resource = "arn:aws:ssm:${var.region}:*:parameter${var.api_key_ssm_param}"
      },
      {
        # SecureString PutParameter with the default aws/ssm KMS key.
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:GenerateDataKey"]
        Resource = "*"
        Condition = {
          StringEquals = { "kms:ViaService" = "ssm.${var.region}.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_iam_instance_profile" "headscale" {
  name = "${local.resource_name}-instance-profile"
  role = aws_iam_role.headscale.name

  tags = local.tags
}

# ─── Elastic IP (stable target for the manual DNS A record) ────────────
resource "aws_eip" "headscale" {
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${local.resource_name}-eip" })
}

resource "aws_eip_association" "headscale" {
  instance_id   = aws_instance.headscale.id
  allocation_id = aws_eip.headscale.id
}

# ─── Instance ──────────────────────────────────────────────────────────
locals {
  user_data = templatefile("${path.module}/install-headscale.sh.tftpl", {
    headscale_version = var.headscale_version
    server_url        = local.server_url
    server_host       = local.server_host
    base_domain       = local.base_domain
    api_key_ssm_param = var.api_key_ssm_param
    region            = var.region
    seed_policy_b64   = base64encode(file("${path.module}/acl.json"))
  })
}

resource "aws_instance" "headscale" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  vpc_security_group_ids      = [aws_security_group.headscale.id]
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.headscale.name
  user_data_base64            = base64gzip(local.user_data)
  user_data_replace_on_change = true

  metadata_options {
    http_tokens                 = "optional"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_size           = 20
    volume_type           = "gp3"
    delete_on_termination = true

    tags = local.tags
  }

  tags = merge(local.tags, { Name = local.resource_name })
}
