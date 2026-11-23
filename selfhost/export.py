#!/usr/bin/env python3
"""Produce a complete source tarball (including the locked Gateway submodule) from the Git index."""
import argparse
import gzip
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import json

ROOT = Path(__file__).resolve().parents[1]

def git(*args, cwd=ROOT):
    return subprocess.check_output(["git", *args], cwd=cwd)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination",type=Path)
    target=parser.parse_args().destination.resolve()
    target.parent.mkdir(parents=True,exist_ok=True)
    tree=git("write-tree").decode().strip()
    lock=json.loads(git("show",tree+":selfhost/upstreams.lock.json"))
    entry=lock["codex-gateway"]
    link=git("ls-tree",tree,"--",entry["path"]).decode().split()
    if link[0]!="160000" or link[2]!=entry["commit"]:
        raise SystemExit("Gateway gitlink and reviewed version differ")
    with tempfile.NamedTemporaryFile(dir=target.parent,delete=False) as output:
        temp=Path(output.name)
        try:
            with gzip.GzipFile(fileobj=output,mode="wb",mtime=0) as zipped,tarfile.open(fileobj=zipped,mode="w|") as tar:
                for cwd,revision,prefix in [(ROOT,tree,"codex-web/"),(ROOT/entry["path"],entry["commit"],"codex-web/"+entry["path"]+"/")]:
                    cmd=["git","archive","--format=tar","--prefix="+prefix,revision]
                    with subprocess.Popen(cmd,cwd=cwd,stdout=subprocess.PIPE) as proc:
                        with tarfile.open(fileobj=proc.stdout,mode="r|") as source:
                            for member in source:
                                if member.isdir() and member.name.rstrip("/")==prefix.rstrip("/"):continue
                                tar.addfile(member,source.extractfile(member) if member.isfile() else None)
                        if proc.wait():raise RuntimeError("git archive failed")
            output.flush()
            os.replace(temp,target)
        finally:
            if temp.exists():temp.unlink()
    print(target)

if __name__=="__main__":main()
