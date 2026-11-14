# TEMPLATE, not a manifest: "kubectl apply -f deploy/k8s/network/" skips it (only *.yaml, *.yml, *.json).
# deploy/k8s/up.sh (step network) fills in the markers on every run and applies the result from stdin:
#   __NODE_IP__   InternalIP of the only node (the kubelet, port 10250)
#   __API_IP__    address of the Kubernetes API from the EndpointSlice of the Service kubernetes (namespace default)
#   __API_PORT__  its port
# No address is stored in the repo: the address of the API can change after a restart of the Rancher Desktop VM
# (then: bash deploy/k8s/up.sh monitoring). A pod reaching the API through the ClusterIP of the Service kubernetes
# (port 443) is matched on the address after DNAT, so the rule names the endpoint, not the Service.
#
# Exception to "no ipBlock" and to "one NetworkPolicy per pod" (stage 9b, decision 13; deploy/k8s/README.md,
# section "Wyjątki"): the kubelet and the API are not pods, so a podSelector cannot name them, and both rules
# need an address known only at runtime. The ingress of prometheus and kube-state-metrics and their other egress
# rules stay in network/monitoring.yaml; these two policies only add one egress rule each.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: prometheus-node
  namespace: shop
  labels:
    app.kubernetes.io/part-of: shop
    app.kubernetes.io/component: network
spec:
  podSelector:
    matchLabels: {app.kubernetes.io/name: prometheus}
  policyTypes: [Egress]
  egress:
    # prometheus -> kubelet of the node 10250: CPU and memory of the pods (/metrics/resource over TLS, token of the
    # service account prometheus, ClusterRole shop-prometheus-kubelet).
    - to:
        - ipBlock: {cidr: __NODE_IP__/32}
      ports: [{protocol: TCP, port: 10250}]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kube-state-metrics-api
  namespace: shop
  labels:
    app.kubernetes.io/part-of: shop
    app.kubernetes.io/component: network
spec:
  podSelector:
    matchLabels: {app.kubernetes.io/name: kube-state-metrics}
  policyTypes: [Egress]
  egress:
    # kube-state-metrics -> Kubernetes API (its port): list and watch of pods, deployments, statefulsets and
    # horizontalpodautoscalers in shop (Role kube-state-metrics).
    - to:
        - ipBlock: {cidr: __API_IP__/32}
      ports: [{protocol: TCP, port: __API_PORT__}]
