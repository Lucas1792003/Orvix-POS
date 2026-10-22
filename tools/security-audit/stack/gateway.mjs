// Disposable API gateway for the org-isolation audit (phf-iso-gw). Same
// path layout as the self-hosted gateway: each prefix is stripped and
// proxied to the real service container on the private phf-iso network.
// Headers (Authorization, apikey, Prefer, Range...) pass through unchanged.
import http from "node:http";
import net from "node:net";

const ROUTES = [
  ["/auth/v1", "http://phf-iso-auth:9999"],
  ["/rest/v1", "http://phf-iso-rest:3000"],
  ["/storage/v1", "http://phf-iso-storage:5000"],
  ["/functions/v1", "http://phf-iso-fn:9000"],
  // opt-in Realtime (PHF_ISO_REALTIME=1), as the self-hosted gateway routes it: the tenant is the Host's first label
  ["/realtime/v1/api", "http://realtime-dev.phf-iso-realtime:4000/api"],
  ["/realtime/v1", "http://realtime-dev.phf-iso-realtime:4000/socket"],
];

const server = http
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
  });

// WebSocket upgrades (Realtime): the same prefix routing, then a raw byte pipe.
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://gw");
  const hit = ROUTES.find(([p]) => url.pathname === p || url.pathname.startsWith(p + "/"));
  if (!hit) { socket.destroy(); return; }
  const [prefix, upstream] = hit;
  const t = new URL(upstream);
  const path = t.pathname.replace(/\/$/, "") + (url.pathname.slice(prefix.length) || "/") + url.search;
  const up = net.connect(Number(t.port), t.hostname, () => {
    const headers = { ...req.headers, host: t.host, "x-forwarded-prefix": prefix };
    up.write(`${req.method} ${path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(8000, "0.0.0.0");
