"""Exercise real merges and submodule updates using isolated local Git repositories."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "upstreams.py"


class UpdateTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.env = {**os.environ, "GIT_ALLOW_PROTOCOL": "file", "GIT_AUTHOR_NAME": "Test", "GIT_COMMITTER_NAME": "Test",
                    "GIT_AUTHOR_EMAIL": "test@example.invalid", "GIT_COMMITTER_EMAIL": "test@example.invalid"}
        self.sources = {}
        for name in ("zcode", "codex-gateway"):
            remote = self.root / name
            remote.mkdir()
            self.run_cmd(remote, "git", "init", "-q", "-b", "main")
            self.commit_file(remote, "base", "original")
            self.sources[name] = {"url": str(remote), "ref": "refs/heads/main",
                                  "commit": self.run_cmd(remote, "git", "rev-parse", "HEAD"),
                                  "path": "." if name == "zcode" else "upstream/codex-gateway"}
        self.checkout = self.root / "product"
        self.run_cmd(self.root, "git", "clone", "-q", self.sources["zcode"]["url"], str(self.checkout))
        self.run_cmd(self.checkout, "git", "submodule", "add", "-q", self.sources["codex-gateway"]["url"], "upstream/codex-gateway")
        home = self.checkout / "selfhost"
        home.mkdir()
        shutil.copy(SCRIPT, home)
        self.lock = home / "upstreams.lock.json"
        self.lock.write_text(json.dumps({"schema": 1, **self.sources}))
        (home / "upstream-history.jsonl").touch()
        self.run_cmd(self.checkout, "git", "add", ".")
        self.run_cmd(self.checkout, "git", "commit", "-qm", "Self-host integration")

    def run_cmd(self, path, *command, success=True):
        p = subprocess.run(command, cwd=path, env=self.env, capture_output=True, text=True)
        if success:
            self.assertEqual(p.returncode, 0, p.stderr)
        else:
            self.assertNotEqual(p.returncode, 0)
        return p.stdout.strip()

    def commit_file(self, path, file, text):
        (path / file).write_text(text + "\n")
        self.run_cmd(path, "git", "add", file)
        self.run_cmd(path, "git", "commit", "-qm", text)

    def tool(self, *args, success=True):
        return self.run_cmd(self.checkout, sys.executable, "selfhost/upstreams.py", *args, success=success)

    def test_each_update_records_only_the_reviewed_sha(self):
        for name, other in (("zcode","codex-gateway"),("codex-gateway","zcode")):
            upstream = Path(self.sources[name]["url"])
            self.commit_file(upstream, "new", "upstream improvement")
            next_sha = self.run_cmd(upstream, "git", "rev-parse", "HEAD")
            old = self.lock.read_text()
            self.tool("prepare",name,"refs/heads/main")
            self.assertEqual(self.lock.read_text(), old)
            self.tool("record",name)
            pins = json.loads(self.lock.read_text())
            self.assertEqual(next_sha, pins[name]["commit"])
            self.assertEqual(json.loads(old)[other]["commit"], pins[other]["commit"])
            self.run_cmd(self.checkout,"git","commit","-qm","Verified update")
            self.tool("status")
        self.assertEqual(len((self.checkout/"selfhost/upstream-history.jsonl").read_text().splitlines()),2)

    def test_conflict_does_not_advance_lock(self):
        self.commit_file(self.checkout, "base", "local work")
        self.commit_file(Path(self.sources["zcode"]["url"]), "base", "upstream work")
        before = self.lock.read_text()
        self.tool("prepare","zcode","refs/heads/main",success=False)
        self.tool("record","zcode",success=False)
        self.assertEqual(before,self.lock.read_text())
        self.run_cmd(self.checkout,"git","merge","--abort")
        self.tool("cancel","zcode")
        self.tool("status")


if __name__ == "__main__":
    unittest.main()
