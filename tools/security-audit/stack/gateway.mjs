// Disposable API gateway for the org-isolation audit (phf-iso-gw). Same
// path layout as the self-hosted gateway: each prefix is stripped and
// proxied to the real service container on the private phf-iso network.
// Headers (Authorization, apikey, Prefer, Range...) pass through unchanged.
import http from "node:http";

const ROUTES = [
  ["/auth/v1", "http://phf-iso-auth:9999"],
  ["/rest/v1", "http://phf-iso-rest:3000"],
  ["/storage/v1", "http://phf-iso-storage:5000"],
  ["/functions/v1", "http://phf-iso-fn:9000"],
];

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://gw");
    const hit = ROUTES.find(([p]) => url.pathname === p || url.pathname.startsWith(p + "/"));
    if (!hit) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "no route" }));
      return;
    }
    const [prefix, upstream] = hit;
    const target = new URL((url.pathname.slice(prefix.length) || "/") + url.search, upstream);
    const up = http.request(
      target,
      { method: req.method, headers: { ...req.headers, host: target.host, "x-forwarded-prefix": prefix } },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "upstream unavailable" }));
    });
    req.pipe(up);
  })
  .listen(8000, "0.0.0.0");
