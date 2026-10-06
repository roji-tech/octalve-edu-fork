#!/usr/bin/env node
// Test-only TLS-terminating reverse proxy: usage `node tls-proxy.mjs <listenPort> <upstreamPort>`.
//
// It stands in for Caddy/nginx so the browser talks real HTTPS to a real
// production build (APP_URL=https://…). That is the only way to see whether
// Chromium accepts the `__Host-` session cookie on login and — the part the
// auth review flagged (docs/auth-review-2026-09-29.md, P0 #4) — actually drops
// it on logout. Dev over plain HTTP can't tell you.
//
// Like a correctly configured production proxy it OVERWRITES x-real-ip with
// the true peer address (never appends to what the client sent). The one
// test-only hook: an `x-test-client-ip` request header is promoted to
// x-real-ip so browser tests can give themselves distinct rate-limit buckets.
// That hook lives here, in the proxy, never in the application.

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [listenPort, upstreamPort] = process.argv.slice(2).map(Number);
if (!listenPort || !upstreamPort) {
  console.error("usage: tls-proxy.mjs <listenPort> <upstreamPort>");
  process.exit(2);
}

// Throwaway self-signed certificate for localhost, generated per run.
const tlsDir = path.resolve("tests/.tmp/tls");
const keyPath = path.join(tlsDir, "localhost-key.pem");
const certPath = path.join(tlsDir, "localhost-cert.pem");
if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  fs.mkdirSync(tlsDir, { recursive: true });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "7",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

const server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (req, res) => {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name)) headers[name] = value;
  }
  const peer = req.socket.remoteAddress ?? "unknown";
  headers["x-real-ip"] = req.headers["x-test-client-ip"] ?? peer;
  delete headers["x-test-client-ip"];
  headers["x-forwarded-for"] = peer;
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-host"] = req.headers.host ?? "";

  const upstream = http.request({ host: "127.0.0.1", port: upstreamPort, method: req.method, path: req.url, headers }, (upstreamRes) => {
    // rawHeaders keeps repeated headers (multiple Set-Cookie) intact and in order.
    const raw = [];
    for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
      if (!HOP_BY_HOP.has(upstreamRes.rawHeaders[i].toLowerCase())) {
        raw.push(upstreamRes.rawHeaders[i], upstreamRes.rawHeaders[i + 1]);
      }
    }
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, raw);
    upstreamRes.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("bad gateway");
  });
  req.pipe(upstream);
});

server.listen(listenPort, () => console.log(`tls-proxy: https://localhost:${listenPort} -> http://127.0.0.1:${upstreamPort}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
