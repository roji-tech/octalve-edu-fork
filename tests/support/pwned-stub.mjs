// A stand-in for the Have I Been Pwned range API, for the tests (nothing in the suite talks to the public service).
//   GET /range/<5 hex chars>  → the suffixes of every "breached" password below that share the prefix (plus padding)
//   GET /__requests           → every range request seen so far, so a test can prove only the PREFIX was ever sent
//   DELETE /__requests        → forget them
import http from "node:http";
import crypto from "node:crypto";

const port = Number(process.argv[2] ?? 3104);
const BREACHED = ["Tr0ub4dor&3-but-leaked", "password1234!", "letmein-2024-school"];
const sha1 = (v) => crypto.createHash("sha1").update(v).digest("hex").toUpperCase();
const seen = [];

http
  .createServer((req, res) => {
    if (req.url === "/__requests") {
      if (req.method === "DELETE") seen.length = 0;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(seen));
    }
    const match = /^\/range\/([0-9A-Fa-f]{5})$/.exec(req.url ?? "");
    if (!match) {
      res.statusCode = 404;
      return res.end("not found");
    }
    const prefix = match[1].toUpperCase();
    seen.push({ prefix, addPadding: req.headers["add-padding"] ?? null });
    const rows = BREACHED.map(sha1).filter((h) => h.startsWith(prefix)).map((h) => `${h.slice(5)}:${1000 + h.charCodeAt(7)}`);
    rows.push("0".repeat(35) + ":0"); // padding row
    res.end(rows.join("\r\n"));
  })
  .listen(port, "127.0.0.1");
