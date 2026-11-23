#!/usr/bin/env python3
"""Review, prepare, and record independent upstream updates. Never pushes or deploys."""
import argparse
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "selfhost/upstreams.lock.json"
HISTORY = ROOT / "selfhost/upstream-history.jsonl"
SOURCES = ("zcode", "codex-gateway")


def git(*args, cwd=ROOT):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_lock():
    lock = json.loads(LOCK.read_text())
    for name in SOURCES:
        require(re.fullmatch(r"[0-9a-f]{40}", lock[name]["commit"]), "Invalid pin for " + name)
    return lock


def gitlink():
    entry = git("ls-files", "--stage", "--", "upstream/codex-gateway").split()
    require(len(entry) >= 3 and entry[0] == "160000" and entry[2] == "0", "Missing or unmerged Gateway gitlink")
    return entry[1]


def ancestor(parent, child, cwd=ROOT):
    result = subprocess.run(["git", "merge-base", "--is-ancestor", parent, child], cwd=cwd)
    return result.returncode == 0


def marker():
    git_dir = Path(git("rev-parse", "--absolute-git-dir"))
    return git_dir / "selfhost-upstream-update.json"


def status(lock):
    for name in SOURCES:
        cfg = lock[name]
        path = ROOT / cfg["path"]
        if name == "zcode":
            merge_head = subprocess.run(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd=ROOT, capture_output=True, text=True)
            require(ancestor(cfg["commit"], "HEAD") or (merge_head.returncode == 0 and merge_head.stdout.strip() == cfg["commit"]), "ZCode pin is outside the checkout history")
        else:
            require(gitlink() == cfg["commit"], "Gateway gitlink does not match lock")
            require(git("rev-parse", "HEAD", cwd=path) == cfg["commit"], "Run git submodule update --init")
            require(not git("status", "--porcelain", cwd=path), "Gateway submodule has unrecorded changes")
        print(f"{name:14} {cfg['commit']}  {cfg['ref']}")


def candidate(cfg, ref):
    require(ref.startswith(("refs/heads/", "refs/tags/")), "Use a full refs/heads/... or refs/tags/... reference")
    git("check-ref-format", ref)
    lines = git("ls-remote", "--exit-code", cfg["url"], ref, ref + "^{}").splitlines()
    targets = dict(line.split(None, 1)[::-1] for line in lines)
    return targets.get(ref + "^{}") or targets[ref]


def prepare(lock, name, ref):
    require(not marker().exists(), "There is already a prepared update")
    require(not git("status", "--porcelain"), "Commit or move your local changes before preparing an update")
    status(lock)
    cfg = lock[name]
    target = candidate(cfg, ref)
    if target == cfg["commit"]:
        print("Already pinned at " + target)
        return
    path = ROOT / cfg["path"]
    git("fetch", "--no-tags", cfg["url"], ref, cwd=path)
    require(target == git("rev-parse", "FETCH_HEAD^{commit}", cwd=path), "Upstream moved during fetch. Review the new revision and retry.")
    require(ancestor(cfg["commit"], target, path), "Candidate is not a descendant of the recorded pin. Fetch the missing history or review the divergence.")
    marker().write_text(json.dumps({"name": name, "ref": ref, "commit": target, "old": cfg["commit"]}) + "\n")
    if name == "zcode":
        subprocess.run(["git", "merge", "--no-ff", "--no-commit", target], cwd=ROOT, check=True)
    else:
        git("switch", "--detach", target, cwd=path)
    print("Prepared " + target + ". Validate the integration, then record the revision.")


def record(lock, name):
    update = json.loads(marker().read_text())
    require(update["name"] == name and update["old"] == lock[name]["commit"], "Update does not match the previous lock")
    require(not git("ls-files", "-u"), "Resolve merge conflicts first")
    target = update["commit"]
    if name == "zcode":
        require(ancestor(target, "HEAD") or git("rev-parse", "MERGE_HEAD") == target, "Prepared ZCode revision is not integrated")
    else:
        path = ROOT / lock[name]["path"]
        require(git("rev-parse", "HEAD", cwd=path) == target and not git("status", "--porcelain", cwd=path), "Gateway checkout is not the reviewed revision")
        git("add", "--", lock[name]["path"])
    if name == "codex-gateway" and "sourceSha256" in lock[name]:
        sys.path.insert(0, str(ROOT / "selfhost/gateway"))
        from source_digest import source_digest
        lock[name]["sourceSha256"] = source_digest(path)
    lock[name].update(commit=target, ref=update["ref"])
    LOCK.write_text(json.dumps(lock, indent=2) + "\n")
    with HISTORY.open("a") as history:
        entry = {n: lock[n]["commit"] for n in SOURCES}
        entry.update(date=datetime.datetime.now(datetime.timezone.utc).date().isoformat(), change="Update " + name)
        history.write(json.dumps(entry) + "\n")
    git("add", "--", str(LOCK), str(HISTORY))
    marker().unlink()
    status(lock)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="action", required=True)
    sub.add_parser("status")
    sub.add_parser("check")
    for action in ("prepare", "record", "cancel"):
        cmd = sub.add_parser(action)
        cmd.add_argument("source", choices=SOURCES)
        if action == "prepare":
            cmd.add_argument("ref")
    args = ap.parse_args()
    lock = read_lock()
    if args.action == "status":
        status(lock)
    elif args.action == "check":
        status(lock)
        for name in SOURCES:
            head = candidate(lock[name], "refs/heads/main")
            print(f"{name} main: {head}  " + ("at pin" if head == lock[name]["commit"] else "review available"))
    elif args.action == "prepare":
        prepare(lock, args.source, args.ref)
    elif args.action == "record":
        record(lock, args.source)
    else:
        update = json.loads(marker().read_text())
        require(update["name"] == args.source, "Wrong prepared source")
        if args.source == "zcode":
            require(not (marker().parent / "MERGE_HEAD").exists(), "Resolve or abort the Git merge first")
        else:
            path = ROOT / lock[args.source]["path"]
            require(not git("status", "--porcelain", cwd=path), "Review submodule changes first")
            git("switch", "--detach", update["old"], cwd=path)
        marker().unlink()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
