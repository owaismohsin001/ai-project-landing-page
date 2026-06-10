provider "aws" {
  region = var.region
}

locals {
  resource_name = var.name_prefix

  tags = {
    ManagedBy = "terraform"
    App       = var.name_prefix
    Role      = "edge-proxy"
  }
}

# ─── Network ───────────────────────────────────────────────────────────
# Reuse the account's default VPC so this module drops into the same
# network the per-user workspace EC2s already live in.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# ─── Ubuntu AMI ────────────────────────────────────────────────────────
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

# ─── Security groups ───────────────────────────────────────────────────
resource "aws_security_group" "alb" {
  name        = "${local.resource_name}-alb-sg"
  description = "Public ALB for the platform edge proxy."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP from internet"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.ingress_cidr]
  }

  ingress {
    description = "HTTPS from internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.ingress_cidr]
  }

  # Router endpoint goes through the ALB on its own port so the URL
  # workspace EC2s poll stays stable across proxy EC2 rebuilds. The ALB
  # forwards to the proxy EC2's router service on the same port.
  ingress {
    description = "Router endpoint from internet"
    from_port   = var.router_port
    to_port     = var.router_port
    protocol    = "tcp"
    cidr_blocks = [var.ingress_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${local.resource_name}-alb-sg" })
}

resource "aws_security_group" "proxy" {
  name        = "${local.resource_name}-sg"
  description = "Central Traefik proxy EC2."
  vpc_id      = data.aws_vpc.default.id

  # Traefik HTTP entrypoint — only the ALB may speak to it.
  ingress {
    description     = "HTTP from ALB"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Traefik dashboard (read-only). Bound to localhost in the config anyway,
  # but keep the SG closed too.
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ingress_cidr]
  }

  # traefik-router HTTP-provider endpoint. Hit from every user EC2's
  # Traefik. Wide open today; lock to the workspace-SG range once we move
  # user EC2s into a known SG/VPC pair.
  ingress {
    description = "traefik-router HTTP provider"
    from_port   = var.router_port
    to_port     = var.router_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${local.resource_name}-sg" })
}

# ─── ALB ───────────────────────────────────────────────────────────────
resource "aws_lb" "edge" {
  name               = local.resource_name
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.default.ids

  tags = local.tags
}

resource "aws_lb_target_group" "proxy" {
  name        = "${local.resource_name}-tg"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "instance"

  health_check {
    path                = "/ping"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = local.tags
}

# HTTP listener: forwards to Traefik when HTTPS is disabled, 301-redirects
# to HTTPS when enabled. Same resource name across both modes so flipping
# the flag updates the listener in place rather than destroying/recreating.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.edge.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = var.enable_https ? "redirect" : "forward"
    target_group_arn = var.enable_https ? null : aws_lb_target_group.proxy.arn

    dynamic "redirect" {
      for_each = var.enable_https ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

# ─── HTTPS (ACM cert + ALB listener) ───────────────────────────────────
# Wildcard cert covers every per-user subdomain (frontend-X.platform...,
# api-X.platform..., etc.) plus the apex. Validation is via DNS — ACM
# tells us a CNAME to add in Namecheap and re-checks every minute until
# it sees it. The validation resource blocks `terraform apply` until ACM
# reports ISSUED, so the workflow is:
#
#   1. terraform apply -target=aws_acm_certificate.platform
#   2. terraform output acm_validation_records   # show CNAME(s) to add
#   3. (add the CNAME records in Namecheap)
#   4. terraform apply                            # validation + listener
resource "aws_acm_certificate" "platform" {
  count                     = var.enable_https ? 1 : 0
  domain_name               = var.platform_domain
  subject_alternative_names = ["*.${var.platform_domain}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

resource "aws_acm_certificate_validation" "platform" {
  count           = var.enable_https ? 1 : 0
  certificate_arn = aws_acm_certificate.platform[0].arn
  validation_record_fqdns = [
    for r in aws_acm_certificate.platform[0].domain_validation_options : r.resource_record_name
  ]

  timeouts {
    create = "30m"
  }
}

resource "aws_lb_listener" "https" {
  count             = var.enable_https ? 1 : 0
  load_balancer_arn = aws_lb.edge.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.platform[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.proxy.arn
  }
}

# ─── Traefik EC2 ───────────────────────────────────────────────────────
locals {
  # Traefik polls the in-box router on localhost — no external dependency,
  # one less round trip than going through the ALB to itself.
  router_url_internal = "http://127.0.0.1:${var.router_port}/api/traefik/global"

  traefik_static_yml = templatefile("${path.module}/traefik.yml.tftpl", {
    backend_config_url  = local.router_url_internal
    config_poll_seconds = var.config_poll_seconds
  })

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    traefik_yml_b64 = base64encode(local.traefik_static_yml)
    # Big text files are gzipped before base64 so the templatefile() doesn't
    # blow the rendered user-data past AWS's limits. Decoded with
    # `base64 -d | gunzip` in the shell script.
    router_js_b64gz = base64gzip(file("${path.module}/router/server.js"))
    router_pkg_b64  = base64encode(file("${path.module}/router/package.json"))
    # Workspace bootstrap script — hosted here so per-user workspaces
    # don't have to embed it in their own user-data and hit AWS's 16KB cap.
    cloud_init_b64gz  = base64gzip(file("${path.module}/../workspace/cloud-init.sh"))
    router_port       = var.router_port
    mongodb_uri       = var.mongodb_uri
    platform_domain   = var.platform_domain
    platform_protocol = var.enable_https ? "https" : "http"
  })
}

# ─── SSM access for hot-iteration ─────────────────────────────────────
# AmazonSSMManagedInstanceCore lets the SSM agent (pre-installed on the
# Ubuntu Noble AMI) register with Systems Manager, which is what enables
# `aws ssm start-session --target <instance-id>` without an SSH key. The
# proxy EC2 was originally launched without a key_name, so SSM is the
# practical way to shell in for hot-swap iteration on
# /opt/traefik-router/bootstrap/cloud-init.sh — see proxy/README's
# "iteration loop" section.
resource "aws_iam_role" "proxy_ssm" {
  name = "${local.resource_name}-ssm-role"

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

resource "aws_iam_role_policy_attachment" "proxy_ssm" {
  role       = aws_iam_role.proxy_ssm.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# The traefik-router resolves each ready workspace's CURRENT public DNS by
# its stable instanceId (the publicDns/IP stored at provision time goes
# stale on every stop/start) and writes it back to Mongo. That needs
# read-only ec2:DescribeInstances. Scoped onto the role the proxy EC2
# already assumes, so no extra instance profile is required.
resource "aws_iam_role_policy" "proxy_ec2_describe" {
  name = "${local.resource_name}-ec2-describe"
  role = aws_iam_role.proxy_ssm.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ec2:DescribeInstances"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_iam_instance_profile" "proxy_ssm" {
  name = "${local.resource_name}-ssm-instance-profile"
  role = aws_iam_role.proxy_ssm.name

  tags = local.tags
}

resource "aws_instance" "proxy" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  vpc_security_group_ids      = [aws_security_group.proxy.id]
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.proxy_ssm.name
  user_data_base64            = base64gzip(local.user_data)
  user_data_replace_on_change = true

  metadata_options {
    http_tokens                 = "optional"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_size           = 16
    volume_type           = "gp3"
    delete_on_termination = true

    tags = local.tags
  }

  tags = merge(local.tags, { Name = local.resource_name })
}

resource "aws_lb_target_group_attachment" "proxy" {
  target_group_arn = aws_lb_target_group.proxy.arn
  target_id        = aws_instance.proxy.id
  port             = 80
}

# ─── Router (in-box Node service) behind the ALB ──────────────────────
# Without this, workspace EC2s have to poll the proxy EC2's raw DNS,
# which changes every time the proxy is rebuilt. Putting the router
# behind the ALB makes the URL stable for the lifetime of the ALB.
resource "aws_lb_target_group" "router" {
  name        = "${local.resource_name}-router-tg"
  port        = var.router_port
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "instance"

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = local.tags
}

resource "aws_lb_target_group_attachment" "router" {
  target_group_arn = aws_lb_target_group.router.arn
  target_id        = aws_instance.proxy.id
  port             = var.router_port
}

resource "aws_lb_listener" "router" {
  load_balancer_arn = aws_lb.edge.arn
  port              = var.router_port
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.router.arn
  }
}
