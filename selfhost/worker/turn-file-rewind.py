"""Apply a gateway-witnessed Codex patch on the SSH worktree. No Git writes."""

import base64
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

MAX_FILE = 2 * 1024 * 1024
MAX_JOURNAL_CONTENT = 24 * 1024 * 1024
ABSENT = "0" * 40
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
HUNK = re.compile(rb"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$", re.DOTALL)
DARWIN = ctypes.CDLL(None, use_errno=True) if sys.platform == "darwin" else None
PROVENANCE = b"com.apple.provenance"


class Refusal(Exception):
    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason


def unsupported(message):
    return Refusal("unsupported_checkpoint", message)


def changed(message="文件与该轮结束时的内容不一致"):
    return Refusal("external_modified", message)


def digest(data):
    if data is None:
        return ABSENT
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def text_bytes(data):
    if len(data) > MAX_FILE or b"\0" in data:
        raise unsupported("仅支持大小在限制内的 UTF-8 文本")
    data.decode("utf-8")
    return data


def physical_lines(data):
    lines = data.split(b"\n")
    return [line + b"\n" for line in lines[:-1]] + ([lines[-1]] if lines[-1] else [])


def reverse_exact(current, patch):
    current_lines = physical_lines(current)
    lines = physical_lines(patch)
    if not lines or len(lines) > 100000:
        raise ValueError("missing hunks")
    cursor, offset, restored = 0, 0, []
    while offset < len(lines):
        match = HUNK.fullmatch(lines[offset].rstrip(b"\n"))
        if match is None:
            raise ValueError("invalid native hunk")
        old_start, old_count, new_start, new_count = [int(part or b"1") for part in match.groups()]
        index = new_start - (1 if new_count else 0)
        old_index = old_start - (1 if old_count else 0)
        if index < cursor or index > len(current_lines) or len(restored) + index - cursor != old_index:
            raise ValueError("invalid native hunk coordinates")
        restored.extend(current_lines[cursor:index])
        cursor = index
        offset += 1
        old_seen, new_seen = 0, 0
        while offset < len(lines) and lines[offset][:1] in (b" ", b"+", b"-"):
            marker, content = lines[offset][:1], lines[offset][1:]
            offset += 1
            if offset < len(lines) and lines[offset].rstrip(b"\n") == b"\\ No newline at end of file":
                content = content.removesuffix(b"\n")
                offset += 1
            if marker != b"-":
                if cursor >= len(current_lines) or current_lines[cursor] != content:
                    raise ValueError("native hunk does not match")
                cursor += 1
                new_seen += 1
            if marker != b"+":
                restored.append(content)
                old_seen += 1
        if (old_seen, new_seen) != (old_count, new_count):
            raise ValueError("incomplete native hunk")
    restored.extend(current_lines[cursor:])
    return b"".join(restored)


def path_parts(path):
    parts = path.split("/")
    if len(parts) > 64 or any(
        part in ("", ".", "..") or part.lower() in (".git", ".zcode-selfhost-turn-rewind") or part.startswith(".zcode-rewind-")
        or "\\" in part or any(ord(char) < 32 or ord(char) == 127 for char in part)
        for part in parts
    ):
        raise unsupported("文件路径不在工作树的普通文件范围内")
    return parts


@contextmanager
def directory(parent, parts):
    fd = os.dup(parent)
    try:
        for part in parts:
            next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    finally:
        os.close(fd)


@contextmanager
def absolute_directory(path):
    root = os.open("/", DIR_FLAGS)
    try:
        with directory(root, [part for part in path.split("/") if part]) as fd:
            yield fd
    finally:
        os.close(root)


def signature(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_gid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def darwin_attribute(fd, name=None):
    method = DARWIN.fgetxattr if name else DARWIN.flistxattr
    def read(buffer, size):
        return method(fd, name, buffer, size, 0, 0) if name else method(fd, buffer, size, 0)
    count = read(None, 0)
    if count < 0 or count > MAX_FILE:
        raise OSError(ctypes.get_errno(), "xattr size")
    buffer = ctypes.create_string_buffer(count)
    if read(buffer, count) != count:
        raise changed("读取文件时属性已更改")
    return buffer.raw


def regular_metadata(fd, info):
    message = "带有扩展属性、访问控制或文件标志的文件需要保留原状"
    if getattr(info, "st_flags", 0) or (hasattr(os, "listxattr") and os.listxattr(fd)):
        raise unsupported(message)
    if DARWIN is None:
        return None
    # macOS 自动写入来源属性。保留其值，拒绝无法还原的其他扩展属性和 ACL。
    names = set(filter(None, darwin_attribute(fd).split(b"\0")))
    if names - {PROVENANCE}:
        raise unsupported(message)
    get_acl = DARWIN.acl_get_fd_np
    get_acl.restype = ctypes.c_void_p
    acl = get_acl(fd, 0x00000100)  # ACL_TYPE_EXTENDED
    if acl:
        try:
            entry = ctypes.c_void_p()
            if DARWIN.acl_get_entry(ctypes.c_void_p(acl), 0, ctypes.byref(entry)) == 0:
                raise unsupported(message)
        finally:
            DARWIN.acl_free(ctypes.c_void_p(acl))
    return darwin_attribute(fd, PROVENANCE).hex() if PROVENANCE in names else None


def read_entry(parent, leaf, internal=False):
    try:
        fd = os.open(leaf, FILE_FLAGS, dir_fd=parent)
    except FileNotFoundError:
        return None, None
    with os.fdopen(fd, "rb") as file:
        initial = os.fstat(file.fileno())
        mode = stat.S_IMODE(initial.st_mode)
        if (not stat.S_ISREG(initial.st_mode) or initial.st_uid != os.geteuid()
                or (not internal and initial.st_nlink != 1) or mode & ~0o777):
            raise unsupported("文件类型、所有者或链接状态不支持安全撤销")
        provenance = regular_metadata(file.fileno(), initial)
        data = text_bytes(file.read(MAX_FILE + 1))
        final = os.fstat(file.fileno())
        visible = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        if signature(initial) != signature(final) or signature(final) != signature(visible):
            raise changed("读取文件时内容或路径已更改")
        return {
            "dev": final.st_dev, "ino": final.st_ino, "mode": mode, "gid": final.st_gid,
            "hash": digest(data), "provenance": provenance,
        }, data


def git_read(cwd, *args):
    env = {key: val for key, val in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_OPTIONAL_LOCKS="0", GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")
    return subprocess.run(
        ["git", "--literal-pathspecs", "-C", cwd, *args], env=env,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=5,
    ).stdout


def deleted_file_mode(cwd, relative_path, old):
    # 原生 diff 的 100644 是合成值。只用同内容的普通 Git index blob 补足删除前的模式。
    try:
        records = git_read(cwd, "ls-files", "--stage", "-z", "--", relative_path).split(b"\0")
        header, path = records[0].split(b"\t", 1)
        mode, oid, stage = header.decode("ascii").split()
        if (len(records) == 2 and path == os.fsencode(relative_path) and stage == "0"
                and mode in ("100644", "100755") and re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", oid)
                and int(git_read(cwd, "cat-file", "-s", oid)) == len(old)
                and git_read(cwd, "cat-file", "blob", oid) == old):
            return int(mode[-3:], 8)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    raise unsupported("缺少可证明删除前内容和文件模式的 Git 索引记录")


def git_admin_paths(cwd):
    # 普通工作树、linked worktree 和 separate-git-dir 都以 Git 报告的实际管理路径为准。
    try:
        if git_read(cwd, "rev-parse", "--is-inside-work-tree").strip() != b"true":
            raise unsupported("文件撤销需要可验证的 Git 工作树")
        admin = git_read(cwd, "rev-parse", "--absolute-git-dir")
        common = git_read(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
        return {Path(os.fsdecode(path.removesuffix(b"\n"))).resolve(strict=True) for path in (admin, common)}
    except (OSError, subprocess.SubprocessError) as error:
        raise unsupported("无法确认工作树的 Git 管理目录") from error


def prepare_file(root, cwd, evidence, protected):
    if evidence.get("reason"):
        raise Refusal(evidence["reason"], evidence.get("message", "缺少该文件的原生补丁凭据"))
    path = evidence["path"]
    *parents, leaf = path_parts(path)
    target = Path(cwd) / path
    if any(target == admin or admin in target.parents for admin in protected):
        raise unsupported("Git 管理文件不支持撤销")
    with directory(root, parents) as parent:
        entry, data = read_entry(parent, leaf)
        parent_info = os.fstat(parent)
    if digest(data) != evidence["after"]:
        raise changed()
    kind = evidence["kind"]
    try:
        patch = text_bytes(evidence["diff"].encode("utf-8"))
        if kind == "update" and entry is not None and evidence["before"] != ABSENT:
            old = text_bytes(reverse_exact(data, patch))
            mode = entry["mode"]
        elif kind == "add" and entry is not None and evidence["before"] == ABSENT:
            if entry["mode"] != 0o644:
                raise changed("新增文件的模式已变更或无法确认")
            if patch != data:
                raise ValueError("added content does not match")
            old, mode = None, None
        elif kind == "delete" and entry is None and evidence["after"] == ABSENT:
            old = patch
            mode = deleted_file_mode(cwd, path, old)
        else:
            raise ValueError("inconsistent evidence")
        if digest(old) != evidence["before"]:
            raise ValueError("reversed content does not match")
    except (UnicodeError, ValueError) as error:
        raise Refusal("checkpoint_unreadable", "原生补丁与该轮的前后内容无法相互印证") from error
    return {
        "path": path, "parent": [parent_info.st_dev, parent_info.st_ino], "current": entry,
        "desired": None if old is None else {
            "content": base64.b64encode(old).decode(), "mode": mode, "gid": entry["gid"] if entry else None,
            "provenance": entry["provenance"] if entry else None,
        },
    }


def preview(root, cwd, files, protected):
    plan, safe, unsafe, seen = [], [], [], set()
    journal_bytes = 0
    for evidence in files:
        path = evidence["path"]
        row = {
            "path": os.path.join(cwd, path), "operationCount": evidence["operationCount"],
            "toolNames": ["apply_patch"],
        }
        try:
            if path in seen:
                raise unsupported("该路径的原生凭据重复")
            seen.add(path)
            step = prepare_file(root, cwd, evidence, protected)
            if step["desired"] is not None:
                journal_bytes += len(step["desired"]["content"])
            if journal_bytes > MAX_JOURNAL_CONTENT:
                raise unsupported("该轮文件内容超出 SSH 撤销事务容量")
        except Refusal as error:
            unsafe.append({**row, "reason": error.reason, "message": str(error)})
        except (OSError, UnicodeError) as error:
            reason = "external_modified" if getattr(error, "errno", None) in (errno.ELOOP, errno.ENOTDIR, errno.ENOENT) else "file_read_failed"
            unsafe.append({**row, "reason": reason, "message": "无法验证工作树中的文件或父目录"})
        else:
            plan.append(step)
            safe.append({**row, "action": "delete" if step["desired"] is None else "restore"})
    return {"canApply": bool(safe) and not unsafe, "safeFiles": safe, "unsafeFiles": unsafe, "ignoredFiles": []}, plan


def sync_directory(path):
    fd = os.open(path, DIR_FLAGS)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_directory(path):
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    else:
        sync_directory(path.parent)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise unsupported("SSH 撤销日志目录不可用")
    return path


def write_record(path, record):
    nonce = path.with_name(f".pending-{secrets.token_hex(12)}")
    try:
        with open(nonce, "x", encoding="utf-8") as file:
            json.dump(record, file, ensure_ascii=True, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
        os.replace(nonce, path)
        sync_directory(path.parent)
    finally:
        nonce.unlink(missing_ok=True)


def read_record(path):
    try:
        with path.open(encoding="utf-8") as file:
            return json.load(file)
    except FileNotFoundError:
        return None


@contextmanager
def lock(journal):
    # 内核随进程退出释放 flock；不依赖可能已被复用的 PID 推断事务所有者。
    fd = os.open(journal / "transaction.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise unsupported("该工作树有另一项文件撤销正在进行") from error
        yield
    finally:
        os.close(fd)


@contextmanager
def step_parent(root, step):
    *parents, leaf = path_parts(step["path"])
    with directory(root, parents) as parent:
        info = os.fstat(parent)
        if [info.st_dev, info.st_ino] != step["parent"]:
            raise changed("文件的父目录已更换")
        yield parent, leaf


def stage_files(root, steps):
    for step in steps:
        with step_parent(root, step) as (parent, _):
            os.mkdir(step["stage"], mode=0o700, dir_fd=parent)
            os.fsync(parent)
            with directory(parent, [step["stage"]]) as stage:
                desired = step["desired"]
                if desired is not None:
                    fd = os.open("new", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage)
                    with os.fdopen(fd, "wb") as file:
                        file.write(base64.b64decode(desired["content"]))
                        file.flush()
                        group = desired["gid"]
                        if group is not None and os.fstat(file.fileno()).st_gid != group:
                            os.fchown(file.fileno(), -1, group)
                        provenance = desired["provenance"]
                        if provenance is not None:
                            data = bytes.fromhex(provenance)
                            if DARWIN.fsetxattr(file.fileno(), PROVENANCE, data, len(data), 0, 0) != 0:
                                raise OSError(ctypes.get_errno(), "fsetxattr")
                        os.fchmod(file.fileno(), desired["mode"])
                        os.fsync(file.fileno())
                step["installed"], _ = read_entry(stage, "new")
                os.fsync(stage)


def present(parent, leaf):
    return read_entry(parent, leaf, internal=True)[0]


def same_moved_file(actual, expected):
    if actual == expected:
        return True
    if DARWIN is None or actual is None or expected is None or not actual["provenance"]:
        return False
    # macOS 会在 SSH 进程移动原 inode 时写入系统来源属性。只在已由本事务移动的
    # 文件上接受此系统属性的更新；仍严格核对 inode、内容、权限、所有者和其他元数据。
    return {**actual, "provenance": expected["provenance"]} == expected


def verify_entry(parent, leaf, expected, path, phase, moved=False):
    actual = present(parent, leaf)
    if actual == expected or (moved and same_moved_file(actual, expected)):
        return
    names = {"dev": "设备", "ino": "文件身份", "mode": "权限", "gid": "用户组", "hash": "内容", "provenance": "系统来源属性"}
    difference = "存在状态" if actual is None or expected is None else "、".join(
        name for key, name in names.items() if actual[key] != expected[key]
    )
    raise changed(f"{path}：{phase}的{difference}与预期不一致")


def move_files(root, steps):
    # 第一处修改前重新校验整个批次。使用独占硬链接安装，避免覆盖后到的文件。
    for step in steps:
        with step_parent(root, step) as (parent, leaf):
            verify_entry(parent, leaf, step["current"], step["path"], "移动前")
    for step in steps:
        with step_parent(root, step) as (parent, leaf), directory(parent, [step["stage"]]) as stage:
            verify_entry(parent, leaf, step["current"], step["path"], "移动前")
            if step["current"] is not None:
                os.rename(leaf, "original", src_dir_fd=parent, dst_dir_fd=stage)
                os.fsync(stage)
                os.fsync(parent)
                verify_entry(stage, "original", step["current"], step["path"], "移动原件后", moved=True)
            if step["installed"] is not None:
                os.link("new", leaf, src_dir_fd=stage, dst_dir_fd=parent, follow_symlinks=False)
                os.fsync(parent)
    for step in steps:
        with step_parent(root, step) as (parent, leaf), directory(parent, [step["stage"]]) as stage:
            verify_entry(parent, leaf, step["installed"], step["path"], "写入后", moved=True)
            verify_entry(stage, "original", step["current"], step["path"], "保留原件后", moved=True)


def restore_step(parent, leaf, stage, step):
    target = present(parent, leaf)
    saved = present(stage, "original")
    removed = present(stage, "withdrawn")
    if removed is not None and not same_moved_file(removed, step["installed"]):
        # 恢复阶段也可能遭遇外部替换。保留第三种内容，等待用户处理竞争。
        if target is None:
            os.link("withdrawn", leaf, src_dir_fd=stage, dst_dir_fd=parent, follow_symlinks=False)
            os.fsync(parent)
        raise changed("恢复时检测到外部替换，保留了文件和 SSH 事务日志")
    if saved is None and step["current"] is not None:
        return
    if target is not None and same_moved_file(target, step["installed"]):
        os.rename(leaf, "withdrawn", src_dir_fd=parent, dst_dir_fd=stage)
        os.fsync(stage)
        os.fsync(parent)
        if present(stage, "withdrawn") != step["installed"]:
            return restore_step(parent, leaf, stage, step)
        target = None
    if target is None and saved is not None:
        os.link("original", leaf, src_dir_fd=stage, dst_dir_fd=parent, follow_symlinks=False)
        os.fsync(parent)
    elif saved is not None and target != saved:
        raise changed("原文件和外部新内容均保留，等待处理 SSH 事务冲突")
    elif target is not None and step["installed"] is not None and target["ino"] == step["installed"]["ino"]:
        raise changed("已写入的文件随后被编辑，保留了文件和 SSH 事务日志")


def clean_step(root, step, restore):
    with step_parent(root, step) as (parent, leaf):
        try:
            stage = os.open(step["stage"], DIR_FLAGS, dir_fd=parent)
        except FileNotFoundError:
            return
        try:
            if restore:
                restore_step(parent, leaf, stage, step)
            for name in ("withdrawn", "original", "new"):
                try:
                    os.unlink(name, dir_fd=stage)
                except FileNotFoundError:
                    pass
            os.fsync(stage)
        finally:
            os.close(stage)
        os.rmdir(step["stage"], dir_fd=parent)
        os.fsync(parent)


def receipt_path(journal, thread, turn):
    key = hashlib.sha256(json.dumps([thread, turn], separators=(",", ":")).encode()).hexdigest()
    return journal / f"{key}.json"


def recover(root, journal):
    pending_path = journal / "pending.json"
    tx = read_record(pending_path)
    if tx is None:
        return
    committed = read_record(receipt_path(journal, tx["threadId"], tx["turnId"]))
    restore = tx["phase"] == "moving" and committed is None
    errors = []
    for step in reversed(tx["steps"]):
        try:
            clean_step(root, step, restore)
        except (OSError, Refusal, UnicodeError):
            errors.append(step["path"])
    if errors:
        raise changed("SSH 事务需要恢复，保留了文件和日志：" + "、".join(errors))
    pending_path.unlink()
    sync_directory(journal)


def run(request):
    selected = Path(request["cwd"])
    if not selected.is_absolute() or selected.is_symlink():
        raise unsupported("工作区根目录已更换或无法验证")
    cwd = str(selected.resolve(strict=True))
    operation = request["operation"]
    thread, turn = request["threadId"], request.get("turnId")
    if any(part.lower() in (".git", ".zcode-selfhost-turn-rewind") for part in Path(cwd).parts):
        raise unsupported("Git 和 SSH 日志目录不支持文件撤销")
    with absolute_directory(cwd) as root:
        info = os.fstat(root)
        homes = Path.home().resolve(strict=True)
        parent = homes / ".zcode-selfhost-turn-rewind"
        journal = parent / f"{info.st_dev}-{info.st_ino}"
        if operation in ("states", "receipt"):
            if not journal.is_dir():
                return {"reverted": []} if operation == "states" else None
            if operation == "receipt":
                receipt = read_record(receipt_path(journal, thread, turn))
                return receipt["result"] if receipt is not None else None
            return {"reverted": [turn_id for turn_id in request.get("turnIds", [turn]) if
                                 read_record(receipt_path(journal, thread, turn_id)) is not None]}
        private_directory(parent)
        private_directory(journal)
        with lock(journal):
            recover(root, journal)
            receipt = receipt_path(journal, thread, turn)
            existing = read_record(receipt)
            if existing is not None:
                if operation == "preview":
                    return {**existing["result"]["preview"], "canApply": False}
                return existing["result"]
            protected = git_admin_paths(cwd)
            result, steps = preview(root, cwd, request["files"], protected)
            # 预览凭据保存在已打开根目录的设备/inode 名下。替换同名目录后必须重新预览。
            consent_path = receipt.with_suffix(".preview")
            evidence_id = hashlib.sha256(json.dumps(
                [cwd, request["files"], [(step["parent"], step["current"]) for step in steps]],
                sort_keys=True, separators=(",", ":")
            ).encode()).hexdigest()
            if operation == "preview":
                if result["canApply"]:
                    write_record(consent_path, evidence_id)
                return result
            if not result["canApply"]:
                conflicts = [f"{item['path']}: {item['message']}" for item in result["unsafeFiles"]]
                return {"applied": False, "preview": result, "response": "；".join(conflicts) or "缺少可撤销文件"}
            if read_record(consent_path) != evidence_id:
                return {"applied": False, "preview": result, "response": "当前工作区或文件凭据已变化，请重新预览"}
            token = secrets.token_hex(12)
            for index, step in enumerate(steps):
                step["stage"] = f".zcode-rewind-{token}-{index}"
            tx = {"phase": "staging", "threadId": thread, "turnId": turn, "commandId": request["commandId"], "steps": steps}
            done = {"applied": True, "preview": result, "response": "已撤销该轮的文件改动"}
            pending = journal / "pending.json"
            write_record(pending, tx)
            try:
                stage_files(root, steps)
                tx["phase"] = "moving"
                write_record(pending, tx)
                move_files(root, steps)
                write_record(receipt, {"commandId": request["commandId"], "result": done})
            except (OSError, Refusal, UnicodeError) as error:
                recover(root, journal)
                fresh, _ = preview(root, cwd, request["files"], protected)
                conflicts = [f"{item['path']}: {item['message']}" for item in fresh["unsafeFiles"]]
                if isinstance(error, OSError):
                    cause = f"SSH 文件操作失败（{errno.errorcode.get(error.errno, 'I/O')}）"
                else:
                    cause = str(error)
                return {"applied": False, "preview": fresh, "response": "；".join(conflicts) or cause}
            recover(root, journal)
            return done


if __name__ == "__main__":
    os.umask(0o077)
    try:
        print(json.dumps(run(json.load(sys.stdin)), ensure_ascii=True))
    except Refusal as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True))
    except (OSError, ValueError, TypeError, KeyError):
        print(json.dumps({"error": "SSH 工作树或文件撤销日志不可读"}, ensure_ascii=True))
