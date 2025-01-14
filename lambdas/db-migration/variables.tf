variable "permissions_boundary_arn" {
  type = string
}

variable "prefix" {
  type = string
}

variable "rds_user_access_secret_arn" {
  description = "AWS Secrets Manager secret ARN containing a JSON string of DB credentials (containing at least host, password, port as keys)"
  type = string
}

variable "rds_security_group_id" {
  type = string
  default = ""
}

variable "subnet_ids" {
  type    = list(string)
  default = []
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "vpc_id" {
  type    = string
  default = null
}
