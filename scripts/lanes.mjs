#!/usr/bin/env node
// TEST LANES (tests/README.md, "Lanes"): run the same suite on several isolated copies of the checkout at once.
//
// The suite is serial because it shares ONE database and a fixed block of ports. A lane is an isolated copy of both: its own directory
// (so its own `.next` build, outbox and results), `TEST_LANE=<n>` (ports + 10·n, database `<name>_lane<n>_test` — see
// tests/support/env.ts). Nothing about WHAT is tested changes: the same specs, the same assertions, the same build — only more of them
// at a time. Lane 0 is the checkout itself; lanes 1–9 live in `$LANES_ROOT` (default: `<repo>/../.octalve-lanes`).
//
//   node scripts/lanes.mjs sync [n…]                refresh lane copies from this checkout (source, .env; installs/generates only when needed)
//   node scripts/lanes.mjs test [--lanes N] [--no-build] [-- <playwright args>]
//                                                   build once, split the suite into N BALANCED lanes, run them at once, one merged verdict
//
// Balancing: the unit of work is a (project, spec file) group — the same granularity Playwright itself keeps serial. Groups are dealt out
// longest-first to whichever lane has the least work so far, using the durations measured on the previous run (`.lane-timings.json`, local,
// ignored by git; a group never seen before is estimated from its test count). Playwright's own `--shard` splits by file COUNT and left one lane
// with every browser spec (17 min) and another with none (1 min) — the schedule is what makes the lanes finish together.
// `test` exits non-zero if ANY lane fails and prints every failing test; the totals are the sum over lanes — compare them with a
// single-lane `pnpm test`: every test runs exactly once, plus the one-test `setup` project once per Playwright invocation.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const lanesRoot = path.resolve(process.env.LANES_ROOT ?? path.join(repo, "..", ".octalve-lanes"));
const laneDir = (n) => (n === 0 ? repo : path.join(lanesRoot, `lane${n}`));

const run = (cmd, args, options = {}) => spawnSync(cmd, args, { stdio: "inherit", ...options });

function sourceFiles() {
  const out = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error("git ls-files failed");
  return out.stdout.split("\0").filter(Boolean);
}

const sha = (file) => (fs.existsSync(file) ? crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex") : "");
const KEEP = new Set(["node_modules", ".next", ".env", "test-results", "playwright-report", ".lane-stamp.json"]);

/// Makes `dir` a faithful copy of the checkout's source (working-tree state, committed or not), without touching what a lane owns
/// (node_modules, .next, results). Installs dependencies only when the lockfile changed; regenerates the Prisma client only when the schema did.
export function syncLane(n) {
  const dir = laneDir(n);
  fs.mkdirSync(dir, { recursive: true });
  const files = sourceFiles().filter((f) => fs.existsSync(path.join(repo, f)));
  const wanted = new Set(files);

  let copied = 0;
  for (const file of files) {
    const from = path.join(repo, file);
    const to = path.join(dir, file);
    if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size && sha(to) === sha(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied++;
  }
  // Remove files that no longer exist in the checkout (outside what the lane owns), so a deleted spec does not linger and run.
  const walk = (current, rel = "") => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && KEEP.has(entry.name)) continue;
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) walk(path.join(current, entry.name), r);
      else if (!wanted.has(r)) fs.rmSync(path.join(current, entry.name));
    }
  };
  walk(dir);

  if (fs.existsSync(path.join(repo, ".env"))) fs.copyFileSync(path.join(repo, ".env"), path.join(dir, ".env"));

  const stampFile = path.join(dir, ".lane-stamp.json");
  const stamp = fs.existsSync(stampFile) ? JSON.parse(fs.readFileSync(stampFile, "utf8")) : {};
  const lock = sha(path.join(repo, "pnpm-lock.yaml")) + sha(path.join(repo, "package.json"));
  const schema = files.filter((f) => f.startsWith("prisma/schema/")).map((f) => sha(path.join(repo, f))).join("");
  if (stamp.lock !== lock || !fs.existsSync(path.join(dir, "node_modules"))) {
    console.log(`[lane ${n}] installing dependencies…`);
    if (run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: dir }).status !== 0) throw new Error(`lane ${n}: pnpm install failed`);
    stamp.schema = ""; // a fresh node_modules needs a fresh client
  }
  if (stamp.schema !== schema) {
    console.log(`[lane ${n}] generating the Prisma client…`);
    if (run("pnpm", ["exec", "prisma", "generate"], { cwd: dir, stdio: "ignore" }).status !== 0) throw new Error(`lane ${n}: prisma generate failed`);
  }
  fs.writeFileSync(stampFile, JSON.stringify({ lock, schema }));
  console.log(`[lane ${n}] in sync (${copied} file${copied === 1 ? "" : "s"} updated) — ${dir}`);
}

function newestSourceMtime() {
  let newest = 0;
  for (const file of sourceFiles()) {
    if (/^(tests|docs|scripts)\//.test(file) || file.endsWith(".md")) continue; // not part of the build
    const full = path.join(repo, file);
    if (fs.existsSync(full)) newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

/// Builds only when the build is older than the code it is built from — lossless: a stale `.next` is never reused.
function buildIfStale() {
  const marker = path.join(repo, ".next", "BUILD_ID");
  if (fs.existsSync(marker) && fs.statSync(marker).mtimeMs > newestSourceMtime()) {
    console.log("[build] up to date — skipping");
    return;
  }
  console.log("[build] building…");
  if (run("pnpm", ["build"], { cwd: repo }).status !== 0) {
    console.error("build failed");
    process.exit(1);
  }
}

function copyBuild(n) {
  const from = path.join(repo, ".next");
  const to = path.join(laneDir(n), ".next");
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

function summarise(log) {
  // The line reporter redraws with ANSI cursor codes; strip them first. A lane runs several invocations: add their tallies.
  const text = fs.readFileSync(log, "utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const count = (word) => [...text.matchAll(new RegExp(`^\\s+(\\d+) ${word}\\b`, "gm"))].reduce((sum, m) => sum + Number(m[1]), 0);
  const failures = [...text.matchAll(/^\s+\d+\) (\[.*)$/gm)].map((m) => m[1].trim());
  return { passed: count("passed"), failed: count("failed"), skipped: count("skipped"), flaky: count("flaky"), failures: [...new Set(failures)] };
}

const TIMINGS = path.join(repo, ".lane-timings.json");
const DEFAULT_SECONDS_PER_TEST = { unit: 0.05, integration: 0.2, api: 1, "e2e-desktop": 3.6, "e2e-mobile": 3.6, https: 1.5 }; // first-run estimates only

/// Every (project, file) group in the suite and how many tests it holds, from `playwright test --list` (which starts no server).
function listGroups() {
  const out = spawnSync("pnpm", ["exec", "playwright", "test", "--list", "--reporter=json"], { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const json = JSON.parse(out.stdout.slice(out.stdout.indexOf("{")));
  const counts = new Map();
  const visit = (suite, file) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.projectName === "setup") continue; // runs once per invocation, as a dependency
        const key = `${t.projectName}|${here}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    for (const child of suite.suites ?? []) visit(child, here);
  };
  for (const suite of json.suites ?? []) visit(suite, suite.file);
  return [...counts].map(([key, tests]) => ({ key, project: key.split("|")[0], file: key.split("|")[1], tests }));
}

function loadTimings() {
  try {
    return JSON.parse(fs.readFileSync(TIMINGS, "utf8"));
  } catch {
    return {};
  }
}

/// Longest-processing-time-first: sort groups by estimated seconds, give each to the lane with the least so far.
export function schedule(groups, timings, lanes) {
  const perProject = {};
  for (const g of groups) {
    const t = timings[g.key];
    if (t !== undefined) {
      perProject[g.project] ??= { seconds: 0, tests: 0 };
      perProject[g.project].seconds += t;
      perProject[g.project].tests += g.tests;
    }
  }
  const perTest = (project) => (perProject[project] ? perProject[project].seconds / perProject[project].tests : (DEFAULT_SECONDS_PER_TEST[project] ?? 5));
  const sized = groups.map((g) => ({ ...g, seconds: timings[g.key] ?? g.tests * perTest(g.project) })).sort((x, y) => y.seconds - x.seconds || x.key.localeCompare(y.key));
  const plan = Array.from({ length: lanes }, () => ({ seconds: 0, groups: [] }));
  for (const g of sized) {
    const lane = plan.reduce((least, l) => (l.seconds < least.seconds ? l : least));
    lane.groups.push(g);
    lane.seconds += g.seconds;
  }
  return plan;
}

function runInvocation(dir, n, args, jsonOut, logFd, timeoutScale) {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["exec", "playwright", "test", ...args, "--reporter=line,json"], {
      cwd: dir,
      env: { ...process.env, TEST_LANE: String(n), TEST_TIMEOUT_SCALE: String(timeoutScale), PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut },
      stdio: ["ignore", logFd, logFd],
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/// Folds measured per-test durations (from the JSON reports) into `.lane-timings.json`, so the next schedule balances on real numbers.
function recordTimings(jsonFiles) {
  const timings = loadTimings();
  const seconds = {};
  const visit = (suite, file) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.projectName === "setup") continue;
        const key = `${t.projectName}|${here}`;
        seconds[key] = (seconds[key] ?? 0) + (t.results ?? []).reduce((sum, r) => sum + (r.duration ?? 0), 0) / 1000;
      }
    }
    for (const child of suite.suites ?? []) visit(child, here);
  };
  for (const file of jsonFiles) {
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const suite of json.suites ?? []) visit(suite, suite.file);
    } catch {
      // a lane that died before writing its report just contributes nothing
    }
  }
  fs.writeFileSync(TIMINGS, JSON.stringify({ ...timings, ...Object.fromEntries(Object.entries(seconds).map(([k, v]) => [k, Math.round(v * 10) / 10])) }, null, 1));
}

async function testCommand(args) {
  const split = args.indexOf("--");
  const own = split === -1 ? args : args.slice(0, split);
  const passthrough = split === -1 ? [] : args.slice(split + 1);
  const lanes = Number(own.includes("--lanes") ? own[own.indexOf("--lanes") + 1] : 3);
  if (!Number.isInteger(lanes) || lanes < 1 || lanes > 9) throw new Error("--lanes must be 1–9");

  if (!own.includes("--no-build")) buildIfStale();
  for (let n = 1; n < lanes; n++) {
    syncLane(n);
    copyBuild(n);
  }

  if (lanes > 1) {
    // Single-token flags (--project=x, --repeat-each=5, --grep=…) and file filters can follow "--"; a flag whose value is a separate word cannot be told from a file filter.
    const unsupported = passthrough.filter((a) => a.startsWith("-") && !/^--[a-z-]+=/.test(a));
    if (unsupported.length) throw new Error(`with several lanes, flags after "--" must be written --flag=value (got ${unsupported.join(" ")})`);
  }
  // Extra Playwright arguments (a project, a file filter) narrow what is scheduled: they are applied to every invocation, so the
  // schedule only needs the groups they leave in.
  const groups = lanes === 1 ? [] : listGroups().filter((g) => (passthrough.filter((a) => a.startsWith("--project=")).length === 0 || passthrough.includes(`--project=${g.project}`)) && passthrough.filter((a) => !a.startsWith("-")).every((f) => g.file.includes(f) || f.includes(g.file)));
  const plan = lanes === 1 ? [{ seconds: 0, groups: [] }] : schedule(groups, loadTimings(), lanes);
  console.log(`[plan] ${lanes === 1 ? "one lane, one invocation" : plan.map((l, n) => `lane ${n}: ${l.groups.length} groups ≈ ${(l.seconds / 60).toFixed(1)} min`).join(" · ")}`);

  const started = Date.now();
  const results = await Promise.all(
    plan.map(async (lane, n) => {
      const dir = laneDir(n);
      const log = path.join(dir, "lane-run.log");
      const fd = fs.openSync(log, "w");
      const jsonFiles = [];
      let code = 0;
      // One invocation per project in the lane, each naming exactly the files it was given — so a file never runs in a project it was not scheduled for.
      const byProject = new Map();
      for (const g of lane.groups) byProject.set(g.project, [...(byProject.get(g.project) ?? []), g.file]);
      const extraFlags = passthrough.filter((a) => a.startsWith("-") && !a.startsWith("--project="));
      const invocations = lanes === 1 ? [passthrough] : [...byProject].map(([project, files]) => [`--project=${project}`, ...extraFlags, ...files.map((f) => `${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)]);
      for (const [i, inv] of invocations.entries()) {
        const jsonOut = path.join(dir, `lane-report-${i}.json`);
        jsonFiles.push(jsonOut);
        fs.writeSync(fd, `\n=== lane ${n} invocation ${i + 1}/${invocations.length}: ${inv.slice(0, 3).join(" ")}${inv.length > 3 ? ` … (+${inv.length - 3})` : ""}\n`);
        code = (await runInvocation(dir, n, inv, jsonOut, fd, lanes > 1 ? 2 : 1)) || code;
      }
      return { n, code, log, jsonFiles };
    }),
  );

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];
  for (const { n, code, log } of results) {
    const s = summarise(log);
    passed += s.passed;
    failed += s.failed;
    skipped += s.skipped;
    failures.push(...s.failures.map((f) => `[lane ${n}] ${f}`));
    console.log(`lane ${n}: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped (exit ${code}) — ${log}`);
  }
  if (passthrough.length === 0) recordTimings(results.flatMap((r) => r.jsonFiles)); // a narrowed or repeated run would skew the schedule
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  console.log(`\nTOTAL over ${lanes} lane${lanes === 1 ? "" : "s"}: ${passed} passed, ${failed} failed, ${skipped} skipped (${minutes} min)`);
  for (const f of failures) console.log(`  FAILED ${f}`);
  const bad = results.some((r) => r.code !== 0) || failed > 0;
  process.exit(bad ? 1 : 0);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "sync") {
  const wanted = rest.length ? rest.map(Number) : [1, 2];
  for (const n of wanted) {
    if (!Number.isInteger(n) || n < 1 || n > 9) throw new Error("lanes are 1–9 (lane 0 is this checkout)");
    syncLane(n);
  }
} else if (command === "test") {
  await testCommand(rest);
} else {
  console.error("usage: node scripts/lanes.mjs sync [n…] | test [--lanes N] [--no-build] [-- <playwright args>]");
  process.exit(2);
}
