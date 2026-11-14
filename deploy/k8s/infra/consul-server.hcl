# Settings of the Consul server in Kubernetes (ConfigMap consul-server-config, created by deploy/k8s/up.sh), next
# to acl.hcl from Secret consul-secret in /consul/config. Changes apply after a restart of consul-0.
#
# No health check output is stored: the response body of a service to the check of the Consul server would be
# readable by every request allowed to read the catalog (stage 7, M2). The checks stay; only Output is empty.
discard_check_output = true
