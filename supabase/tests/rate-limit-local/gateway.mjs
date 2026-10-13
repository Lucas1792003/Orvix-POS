// Disposable stand-in for the API gateway in the rate-limit local e2e
// (run.sh). Listens on :8000 inside the phf-rl network:
//   /rest/v1/*              -> proxied to PostgREST (REST_UPSTREAM), prefix stripped
//   /storage/v1/object/...  -> a STUB of storage-api for the two routes the
//                              phone-upload-token function uses:
//                              HEAD object  -> 400 (not found) unless uploaded via PUT
//                              POST upload/sign/<bucket>/<path> -> {url: ...?token=<fake JWT>}
// The real storage-api behaviour (60 s signed tokens, upsert false) is covered
// by the live suites; here only the database limiter is real.
import http from "node:http";

const REST = new URL(process.env.REST_UPSTREAM ?? "http://phf-rl-rest:3000");
const objects = new Set();
let signed = 0;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://gw");
  if (url.pathname.startsWith("/rest/v1/")) {
    const target = new URL(url.pathname.slice("/rest/v1".length) + url.search, REST);
    const up = http.request(target, { method: req.method, headers: { ...req.headers, host: REST.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
    return;
  }
  if (url.pathname.startsWith("/storage/v1/object/")) {
    const rest = decodeURIComponent(url.pathname.slice("/storage/v1/object/".length));
    if (req.method === "HEAD") {
      res.writeHead(objects.has(rest) ? 200 : 400);
      res.end();
      return;
    }
    if (req.method === "POST" && rest.startsWith("upload/sign/")) {
      const full = rest.slice("upload/sign/".length);
      const now = Math.floor(Date.now() / 1000);
      const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ url: full, iat: now, exp: now + 60 })}.stub-${signed++}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: `/object/upload/sign/${full}?token=${token}` }));
      return;
    }
    if (req.method === "GET" && rest === "_stats") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ signed }));
      return;
    }
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: "not routed by the test gateway" }));
});
server.listen(8000, "0.0.0.0");
