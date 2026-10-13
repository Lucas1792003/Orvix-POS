import http from "node:http";
http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ path: req.url })); }).listen(9000, "0.0.0.0");
