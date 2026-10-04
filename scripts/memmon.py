#!/usr/bin/env python3
"""Samples system memory + per-process RSS every N seconds into a CSV.

Reads the current stage label from results/stage.txt so samples can be grouped by pipeline stage.
Uses only macOS tools (vm_stat, sysctl, memory_pressure, ps) and the stdlib. Run in background;
stop with SIGTERM.

Columns:
  t           seconds since start
  stage       label from stage.txt
  free_pct    `memory_pressure` "System-wide memory free percentage" (higher = less pressure)
  avail_mb    (free + inactive + speculative + purgeable pages) * page size: reclaimable-ish memory
  wired_mb, active_mb, compressor_mb   from vm_stat
  swap_used_mb  from sysctl vm.swapusage
  pageouts, swapouts   cumulative counters (deltas show thrashing)
  rss_<name>_mb   summed RSS of processes whose command line matches each watched pattern
"""
import csv, os, re, signal, subprocess, sys, time

OUT = sys.argv[1]
INTERVAL = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
STAGE_FILE = os.path.join(os.path.dirname(OUT), "stage.txt")
WATCH = {  # name -> substring of the command line
    "comfy": "comfyui/main.py",
    "ollama_serve": "ollama serve",
    "ollama_model": "llama-server",   # Ollama 0.32.5 runs the loaded model in this child process
    "piper": "piper",
    "ffmpeg": "ffmpeg ",
}
running = True
signal.signal(signal.SIGTERM, lambda *_: globals().update(running=False))
signal.signal(signal.SIGINT, lambda *_: globals().update(running=False))


def sh(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout


def vm():
    out = sh("vm_stat")
    page = int(re.search(r"page size of (\d+) bytes", out).group(1))
    get = lambda label: int(re.search(label + r":\s+(\d+)", out).group(1))
    mb = lambda pages: round(pages * page / 1048576)
    return {
        "avail_mb": mb(get("Pages free") + get("Pages inactive") + get("Pages speculative") + get("Pages purgeable")),
        "wired_mb": mb(get("Pages wired down")),
        "active_mb": mb(get("Pages active")),
        "compressor_mb": mb(get("Pages occupied by compressor")),
        "pageouts": get("Pageouts"),
        "swapouts": get("Swapouts"),
    }


def swap_used_mb():
    m = re.search(r"used = ([\d.]+)M", sh("sysctl", "vm.swapusage"))
    return float(m.group(1)) if m else -1


def free_pct():
    m = re.search(r"free percentage:\s+(\d+)%", sh("memory_pressure"))
    return int(m.group(1)) if m else -1


def footprint_mb(pid):
    """macOS `footprint`: dirty+swapped+GPU-mapped memory attributed to the process (RSS misses Metal buffers)."""
    try:
        m = re.search(r"Footprint:\s+([\d.]+)\s+(KB|MB|GB)", sh("footprint", "-p", str(pid)))
    except Exception:
        return 0
    if not m:
        return 0
    return float(m.group(1)) * {"KB": 1 / 1024, "MB": 1, "GB": 1024}[m.group(2)]


def rss():
    sums = {k: 0 for k in WATCH}
    foot = {k: 0.0 for k in WATCH}
    for line in sh("ps", "-axo", "pid=,rss=,command=").splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 3:
            continue
        pid, kb, cmd = int(parts[0]), int(parts[1]), parts[2]
        if "memmon.py" in cmd:
            continue
        for name, pat in WATCH.items():
            if pat in cmd:
                sums[name] += kb
                if name != "ollama_serve":
                    foot[name] += footprint_mb(pid)
    out = {f"rss_{k}_mb": round(v / 1024) for k, v in sums.items()}
    out.update({f"foot_{k}_mb": round(v) for k, v in foot.items() if k != "ollama_serve"})
    return out


t0 = time.time()
with open(OUT, "w", newline="") as f:
    w = None
    while running:
        try:
            stage = open(STAGE_FILE).read().strip()
        except OSError:
            stage = ""
        row = {"t": round(time.time() - t0, 1), "stage": stage, "free_pct": free_pct(), "swap_used_mb": swap_used_mb(), **vm(), **rss()}
        if w is None:
            w = csv.DictWriter(f, fieldnames=list(row))
            w.writeheader()
        w.writerow(row)
        f.flush()
        time.sleep(INTERVAL)
