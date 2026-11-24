"""Exercise release cleanup against a controlled Docker inventory."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "update.sh"

DOCKER = """\
#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

path = Path(os.environ['DOCKER_FIXTURE'])
state = json.loads(path.read_text())
args = sys.argv[1:]
if args == ['compose', 'ps', '-q', 'codex-web']:
    print('web')
elif args[:2] == ['compose', 'up']:
    if state.get('fail_after_replace'):
        state['current'] = 'zcode-selfhost:new'
        state['health'] = 'unhealthy'
        path.write_text(json.dumps(state))
        sys.exit(1)
    if state.get('fail'):
        sys.exit(1)
    state['current'] = 'zcode-selfhost:new'
    state['health'] = 'healthy'
elif args[:3] == ['container', 'inspect', '--format'] and args[-1] == 'web':
    tag = state['current']
    print(state['health'], state['images'][tag], tag)
elif args == ['container', 'ls', '--all', '--quiet']:
    print('stopped')
elif args[:3] == ['container', 'inspect', '--format'] and args[-1] == 'stopped':
    print('used-id')
elif args[:4] == ['image', 'inspect', '--format', '{{len .RepoTags}} {{len .RepoDigests}}']:
    image_id = args[-1]
    if image_id not in state['images'].values() and image_id != 'retired-id':
        sys.exit(1)
    print(list(state['images'].values()).count(image_id), 0)
elif args[:4] == ['image', 'inspect', '--format', '{{.Id}}']:
    tag = args[-1]
    if tag not in state['images']:
        sys.exit(1)
    print(state['images'][tag])
elif args[:2] == ['image', 'tag']:
    image_id, tag = args[2:]
    state['images'][tag] = image_id
elif args[:4] == ['image', 'ls', '--no-trunc', '--format'] and args[-1] == 'zcode-selfhost':
    for tag, image_id in state['images'].items():
        if tag.startswith('zcode-selfhost:'):
            print(tag, image_id, state['created'].get(image_id, '2026-11-22'), '10:00:00 +0000 UTC')
elif args[:3] == ['image', 'rm', '--no-prune']:
    tag = args[-1]
    state['images'].pop(tag, None)
    state['removed'].append(tag)
else:
    sys.exit('Unexpected docker call: ' + str(args))
path.write_text(json.dumps(state))
"""


class UpdateCleanupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / "selfhost").mkdir()
        shutil.copy(SCRIPT, self.root / "selfhost")
        docker = self.root / "docker"
        docker.write_text(DOCKER)
        docker.chmod(0o700)
        self.state_file = self.root / "inventory.json"
        self.state = {
            "current": "zcode-selfhost:previous",
            "health": "healthy",
            "images": {
                "zcode-selfhost:new": "new-id",
                "zcode-selfhost:previous": "old-id",
                "zcode-selfhost:rollback": "retired-id",
                "zcode-selfhost:used": "used-id",
                "zcode-selfhost:stale": "stale-id",
                "zcode-selfhost:future-candidate": "future-id",
                "other:stale": "other-id",
            },
            "created": {"new-id": "2026-11-23", "future-id": "2026-11-24"},
            "removed": [],
        }

    def update(self, *args):
        self.state_file.write_text(json.dumps(self.state))
        env = {**os.environ, "PATH": f"{self.root}:{os.environ['PATH']}",
               "DOCKER_FIXTURE": str(self.state_file)}
        result = subprocess.run(["sh", "selfhost/update.sh", *args], cwd=self.root,
                                env=env, capture_output=True, text=True)
        return result, json.loads(self.state_file.read_text())

    def test_healthy_update_keeps_current_previous_and_container_references(self):
        result, state = self.update("--no-build")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state["images"]["zcode-selfhost:rollback"], "old-id")
        self.assertEqual(state["images"]["zcode-selfhost:new"], "new-id")
        self.assertEqual(state["images"]["zcode-selfhost:used"], "used-id")
        self.assertEqual(state["images"]["other:stale"], "other-id")
        self.assertEqual(state["images"]["zcode-selfhost:future-candidate"], "future-id")
        self.assertIn("zcode-selfhost:stale", state["removed"])
        self.assertIn("retired-id", state["removed"])

    def test_failed_update_keeps_images(self):
        self.state["fail"] = True
        result, state = self.update("--build")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        for tag, image in self.state["images"].items():
            self.assertEqual(state["images"][tag], image)
        self.assertEqual(state["removed"], [])

    def test_retry_after_container_replacement_keeps_last_healthy_until_acceptance(self):
        self.state["fail_after_replace"] = True
        first, self.state = self.update("--stage")
        self.assertNotEqual(first.returncode, 0)
        self.assertEqual(self.state["current"], "zcode-selfhost:new")
        self.assertEqual(self.state["removed"], [])
        self.state.pop("fail_after_replace")
        retry, self.state = self.update("--stage")
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(self.state["removed"], [])
        accepted, state = self.update("--cleanup")
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertEqual(state["images"]["zcode-selfhost:rollback"], "old-id")
        self.assertEqual(state["images"]["zcode-selfhost:new"], "new-id")
        self.assertNotIn("zcode-selfhost:pending-rollback", state["images"])

    def test_cleanup_requires_a_healthy_service(self):
        self.state["health"] = "unhealthy"
        result, state = self.update("--cleanup")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("尚未通过健康检查", result.stderr)
        self.assertEqual(state["removed"], [])

    def test_cleanup_after_an_external_update_uses_the_requested_rollback(self):
        self.state["current"] = "zcode-selfhost:new"
        result, state = self.update("--cleanup", "zcode-selfhost:previous")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state["images"]["zcode-selfhost:rollback"], "old-id")
        self.assertIn("zcode-selfhost:stale", state["removed"])


if __name__ == "__main__":
    unittest.main()
