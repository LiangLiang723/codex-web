import hashlib
from pathlib import Path

def source_digest(root):
    root = Path(root)
    digest = hashlib.sha256()
    paths = [root / "LICENSE"]
    for directory in ("server", "shared"):
        paths.extend(path for path in (root / directory).rglob("*") if path.is_file())
    for path in sorted(paths, key=lambda entry:entry.relative_to(root).as_posix()):
        if path.is_symlink(): raise ValueError("Unexpected symlink in Gateway sources")
        name = path.relative_to(root).as_posix().encode()
        content = path.read_bytes()
        digest.update(len(name).to_bytes(4, "big") + name + len(content).to_bytes(8, "big") + content)
    return digest.hexdigest()
