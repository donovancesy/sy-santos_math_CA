// Sipra website: tiny local web server (needs Node.js, nothing else).
// Run:  node serve.js      then open http://127.0.0.1:8080
// Serves only this folder, only to your own computer.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4"
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath.endsWith("/")) urlPath += "index.html";
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
});

// If the port is taken, try the next few.
let port = PORT;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && port < PORT + 20) { port += 1; server.listen(port, "127.0.0.1"); }
  else { console.error(err.message); process.exit(1); }
});
server.on("listening", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Sipra is running at ${url}`);
  console.log("Keep this window open while you use it. Close it (or press Ctrl+C) to stop.");
  if (process.argv.includes("--open")) {
    require("child_process").exec(process.platform === "win32" ? `start "" "${url}"` : `open "${url}"`);
  }
});
server.listen(port, "127.0.0.1");
