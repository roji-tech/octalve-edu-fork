#!/usr/bin/env python3
"""Parallel mutation runner: the same protocol as run-mutations.py (inject ONE bug, run the targeted tests, expect RED, restore),
but N mutations at once. Each worker owns a LANE (scripts/lanes.mjs): a copy of the checkout with its own ports, database
(`<db>_lane<n>_test`), Redis and `.next`. A mutation is applied to the LANE's copy and undone by copying the file back from this
checkout, which is never edited — so it can stay clean, and you can keep working in it while a pass runs.

usage:  python3 docs/development-history/handoff/tools/run-mutations-parallel.py <mutations.py> <results.jsonl>
            [--lanes N] [--scale S] [--baseline] [ids...]

  --lanes N    workers / lanes 1..N (default 3; lanes are 1-9). Each lane runs ~6 servers (+ Chromium for browser tests): ~2-3 GB.
  --scale S    TEST_TIMEOUT_SCALE for every command (default 2): several lanes share the cores, and a test that merely TIMES OUT under
               load would otherwise be indistinguishable from a caught mutation. (Verdicts whose failure text mentions a timeout are
               still flagged `timeout_suspect` — read those by hand.)
  --baseline   first run every distinct (command, build) pair UNMUTATED on the lanes and stop if any is red.
  ids...       only these mutation ids; the default is all that are not already in <results.jsonl> (resumable, shared with the serial runner).

Needs a clean checkout (it is copied to the lanes as it is). After editing tests or source — e.g. to kill a survivor — commit, delete the
survivor's line from the jsonl and re-run its id: the lanes are re-synced at the start of every run.
Records: the same fields as the serial runner plus lane, seconds and timeout_suspect."""
import json, os, queue, re, shutil, subprocess, sys, threading, time
from urllib.parse import urlparse

args = sys.argv[1:]
def opt(name, default):
    if name in args:
        i = args.index(name)
        val = args[i + 1]
        del args[i:i + 2]
        return type(default)(val)
    return default
LANES = opt("--lanes", 3)
SCALE = opt("--scale", 2)
baseline = "--baseline" in args
args = [a for a in args if a != "--baseline"]
if len(args) < 2 or not 1 <= LANES <= 9:
    raise SystemExit(__doc__)
mfile, out, *only = args
only = set(only)
ns = {}
exec(open(mfile).read(), ns)
ALL = ns["MUTATIONS"]

REPO = os.getcwd()
LANES_ROOT = os.path.abspath(os.environ.get("LANES_ROOT", os.path.join(REPO, "..", ".octalve-lanes")))
lane_dir = lambda n: os.path.join(LANES_ROOT, f"lane{n}")


def sh(cmd, cwd=REPO, env=None, timeout=2400):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout, cwd=cwd, env={**os.environ, **(env or {})})
    return p.returncode, p.stdout + p.stderr


def env_value(key):
    for line in open(os.path.join(REPO, ".env")):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit(f"{key} missing from .env")


if sh("git diff --quiet && git diff --cached --quiet")[0] != 0:
    raise SystemExit("refusing to start: uncommitted changes to tracked files (the lanes are copies of this checkout — commit or stash first)")

done = {json.loads(l)["id"] for l in open(out)} if os.path.exists(out) else set()
TODO = [m for m in ALL if (not only or m["id"] in only) and (only or m["id"] not in done)]
if only:  # an explicit id is re-run even if it was recorded; its old line is superseded by the new one (last wins when reading)
    pass
for m in TODO:
    for f, old, _ in m["edits"]:
        n = open(os.path.join(REPO, f)).read().count(old)
        if n != 1:
            raise SystemExit(f"{m['id']}: pattern occurs {n}x in {f}: {old[:80]!r}")
if not TODO:
    raise SystemExit("nothing to do")

admin = urlparse(env_value("DIRECT_URL"))
ADMIN_URL = f"postgresql://{admin.username}:{admin.password}@{admin.hostname}:{admin.port}/postgres"
DB_BASE = admin.path.lstrip("/")
test_db = lambda lane: f"{DB_BASE}_lane{lane}_test"

print(f"[setup] {len(TODO)} mutation(s) on {LANES} lane(s), timeout scale {SCALE}", flush=True)
for n in range(1, LANES + 1):
    code, text = sh(f"node scripts/lanes.mjs sync {n}")
    if code != 0:
        raise SystemExit(f"lane {n} sync failed:\n{text[-1500:]}")


def lane_build(n):
    code, text = sh("pnpm build", cwd=lane_dir(n), timeout=1200)
    if code != 0:
        raise SystemExit(f"lane {n}: the unmutated build fails:\n{text[-1500:]}")


threads = [threading.Thread(target=lane_build, args=(n,)) for n in range(1, LANES + 1)]
[t.start() for t in threads]
[t.join() for t in threads]
print("[setup] lanes built", flush=True)

NEEDS_BUILD_OUTPUT = re.compile(r"--project=(api|e2e|https)")
lock = threading.Lock()
rows_done = []


def run_cmd(lane, cmd):
    return sh(cmd, cwd=lane_dir(lane), env={"TEST_LANE": str(lane), "TEST_TIMEOUT_SCALE": str(SCALE)})


if baseline:
    pairs = []
    for m in TODO:
        key = (m["cmd"], bool(m.get("build")))
        if key not in pairs:
            pairs.append(key)
    bq = queue.Queue()
    [bq.put(p) for p in pairs]
    bad = []

    def base_worker(lane):
        while True:
            try:
                cmd, _ = bq.get_nowait()
            except queue.Empty:
                return
            code, text = run_cmd(lane, cmd)
            with lock:
                print(("baseline green: " if code == 0 else "BASELINE RED:   ") + cmd[:110], flush=True)
                if code != 0:
                    bad.append((cmd, text[-2500:]))

    ts = [threading.Thread(target=base_worker, args=(n,)) for n in range(1, LANES + 1)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    if bad:
        raise SystemExit("BASELINE RED for: " + bad[0][0] + "\n" + bad[0][1])

work = queue.Queue()
# cheap, no-build mutations first; builds last (they are the slow ones and leave the lane's .next mutated)
for m in sorted(TODO, key=lambda m: bool(m.get("build"))):
    work.put(m)


def worker(lane):
    d = lane_dir(lane)
    dirty_build = False  # this lane's .next was built from a mutated tree
    while True:
        try:
            m = work.get_nowait()
        except queue.Empty:
            return
        rec = {"id": m["id"], "desc": m["desc"], "lane": lane, "started": time.strftime("%H:%M:%S")}
        t0 = time.time()
        files = sorted({f for f, _, _ in m["edits"]})
        try:
            if dirty_build and not m.get("build") and NEEDS_BUILD_OUTPUT.search(m["cmd"]):
                lane_build(lane)  # restore a clean build before a command that runs the built app
                dirty_build = False
            for f, old, new in m["edits"]:
                p = os.path.join(d, f)
                text = open(p).read()
                if text.count(old) != 1:
                    raise RuntimeError(f"pattern drift in lane copy of {f}")
                open(p, "w").write(text.replace(old, new))
            if m.get("fresh_db"):
                sh(f"psql \"{ADMIN_URL}\" -qc 'DROP DATABASE IF EXISTS \"{test_db(lane)}\" WITH (FORCE)'")
            if m.get("build"):
                dirty_build = True
                code, text = sh("pnpm build", cwd=d, timeout=1200)
                if code != 0:
                    rec.update(result="BUILD-FAIL", detail=text[-600:])
                    raise StopIteration
            code, text = run_cmd(lane, m["cmd"])
            plain = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text)
            failed = re.findall(r"^\s+\d+\) (\[.*)$", plain, re.M)[:3]
            tail = [l for l in plain.splitlines() if re.search(r"\d+ (passed|failed)", l)][-2:]
            rec.update(result="CAUGHT" if code != 0 else "SURVIVED", failed=failed, summary=tail)
            if code != 0 and re.search(r"Test timeout of|Timeout \d+ms exceeded|timed out", plain):
                rec["timeout_suspect"] = True
        except StopIteration:
            pass
        except Exception as e:  # noqa
            rec.update(result="ERROR", detail=str(e))
        finally:
            for f in files:
                shutil.copyfile(os.path.join(REPO, f), os.path.join(d, f))  # undo: the checkout is pristine
            if m.get("fresh_db"):
                sh(f"psql \"{ADMIN_URL}\" -qc 'DROP DATABASE IF EXISTS \"{test_db(lane)}\" WITH (FORCE)'")
        rec["finished"] = time.strftime("%H:%M:%S")
        rec["seconds"] = round(time.time() - t0)
        with lock:
            open(out, "a").write(json.dumps(rec) + "\n")
            rows_done.append(rec)
            flag = " [timeout?]" if rec.get("timeout_suspect") else ""
            print(f"{rec['result']:9} {m['id']:5} L{lane} {rec['seconds']:4}s {m['desc'][:80]}{flag}", flush=True)


ts = [threading.Thread(target=worker, args=(n,)) for n in range(1, LANES + 1)]
[t.start() for t in ts]
[t.join() for t in ts]

latest = {}
for l in open(out):
    r = json.loads(l)
    latest[r["id"]] = r
rows = list(latest.values())
print("\n", {k: sum(1 for r in rows if r["result"] == k) for k in ("CAUGHT", "SURVIVED", "BUILD-FAIL", "ERROR")}, f"of {len(rows)} recorded")
for r in rows:
    if r["result"] != "CAUGHT":
        print(f"  {r['result']:10} {r['id']:5} {r['desc'][:100]}")
for r in rows:
    if r.get("timeout_suspect"):
        print(f"  TIMEOUT? {r['id']:5} caught, but the failure text mentions a timeout — read it: {r.get('failed')}")
