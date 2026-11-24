// Serves a Flutter web build and proxies /api and /media to the API, like the Next.js website does, so the app
// runs same-origin (the browser keeps the pc_refresh cookie). No dependencies.
//   node tools/parity/serve.cjs <build/web dir> <port> <api origin>
const http = require("http");
const fs = require("fs");
const path = require("path");
const [root, port = "3200", api = "http://localhost:8100"] = process.argv.slice(2);
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".ttf": "font/ttf", ".otf": "font/otf", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".bin": "application/octet-stream" };
const target = new URL(api);
http.createServer((req, res) => {
  if (req.url.startsWith("/api/") || req.url.startsWith("/media/")) {
    const p = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: target.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(p);
    return;
  }
  let file = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(path.resolve(root)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
}).listen(Number(port), () => console.log(`serving ${root} on :${port}, api ${api}`));
