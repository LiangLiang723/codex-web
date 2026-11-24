#!/usr/bin/env python3
"""Export only the pinned Gateway server and shared protocol into an empty build directory."""
from source_digest import source_digest
import argparse
import io
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("destination", type=Path)
    dest = args.parse_args().destination.resolve()
    pin = json.loads((HERE.parent / "upstreams.lock.json").read_text())["codex-gateway"]
    source = ROOT / pin["path"]
    dest.mkdir(parents=True, exist_ok=True)
    if any(dest.iterdir()):
        raise SystemExit("Choose an empty build directory")
    if (source / ".git").exists():
        if subprocess.check_output(["git","rev-parse","HEAD"],cwd=source,text=True).strip() != pin["commit"]:
            raise SystemExit("Gateway checkout differs from upstreams.lock.json")
        archive = subprocess.check_output(["git", "archive", pin["commit"], "--", "server", "shared", "LICENSE"], cwd=source)
        with tarfile.open(fileobj=io.BytesIO(archive)) as files:
            for item in files:
                if not item.isfile(): continue
                target = dest / item.name
                if dest not in target.resolve().parents: raise ValueError("Invalid repository path")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(files.extractfile(item).read())
    else:
        # Docker contexts and release archives do not contain Git control files.
        for directory in ("server","shared"):
            shutil.copytree(source/directory,dest/directory,symlinks=True)
        shutil.copy2(source/"LICENSE",dest/"LICENSE")
    if source_digest(dest) != pin["sourceSha256"]:
        raise SystemExit("Gateway source digest differs from the reviewed commit")
    patches = [str(HERE / name) for name in ("secure-central.patch", "native-ui.patch", "workspace-avatar.patch", "native-thread-metadata.patch", "native-approvals.patch")]
    # The destination may be inside the parent checkout. Git must apply paths relative
    # to the exported tree, even when that build directory is gitignored.
    env = {**os.environ, "GIT_CEILING_DIRECTORIES": str(dest.parent)}
    for patch in patches:
        for flags in (["--check"], []):
            subprocess.run(["git", "apply", "--no-index", *flags, patch], cwd=dest, env=env, check=True)
    if "A verified SSH host fingerprint" not in (dest / "server/utils/gateway/infra/ssh/ssh-host-trust.ts").read_text():
        raise RuntimeError("Strict host identity overlay was not applied")
    shutil.copytree(HERE / "overlay", dest / "server", dirs_exist_ok=True)
    for name in ("package.json","package-lock.json","nitro.config.ts"):
        if (HERE/name).exists():
            shutil.copy2(HERE/name, dest/name)
    print("Materialized Gateway " + pin["commit"])


if __name__ == "__main__":
    main()
