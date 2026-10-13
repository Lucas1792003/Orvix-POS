# Assemble a minimal Envoy bootstrap that embeds the two snippet blocks of an
# Envoy rate-limit snippet (path given as argv[1]) verbatim (re-indented),
# plus a catch-all functions route like the upstream one, for local validation.
import sys, textwrap
src = open(sys.argv[1]).read().splitlines()
# block 1: from "- name: envoy.filters.http.local_ratelimit" to the blank line
i1 = next(i for i, l in enumerate(src) if l.startswith("- name: envoy.filters.http.local_ratelimit"))
j1 = next(i for i in range(i1, len(src)) if src[i].strip() == "")
filt = "\n".join(src[i1:j1])
i2 = next(i for i, l in enumerate(src) if l.startswith("- name: functions-v1-phone-upload-token"))
route = "\n".join(src[i2:])
ind = lambda s, n: textwrap.indent(s, " " * n)
cfg = f"""static_resources:
  listeners:
    - name: supabase
      address: {{ socket_address: {{ address: 0.0.0.0, port_value: 8000 }} }}
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                '@type': type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: ingress_http
                use_remote_address: true
                route_config:
                  name: local
                  virtual_hosts:
                    - name: all
                      domains: ["*"]
                      routes:
{ind(route, 24)}
                        - name: functions-v1-all
                          match: {{ prefix: /functions/v1/ }}
                          route: {{ cluster: functions, prefix_rewrite: / }}
                http_filters:
                  - name: envoy.filters.http.rbac
                    typed_config:
                      '@type': type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBAC
{ind(filt, 18)}
                  - name: envoy.filters.http.router
                    typed_config:
                      '@type': type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
    - name: functions
      type: STRICT_DNS
      load_assignment:
        cluster_name: functions
        endpoints:
          - lb_endpoints:
              - endpoint: {{ address: {{ socket_address: {{ address: phf-rl-up, port_value: 9000 }} }} }}
admin:
  address: {{ socket_address: {{ address: 0.0.0.0, port_value: 9901 }} }}
"""
open(sys.argv[2], "w").write(cfg)
