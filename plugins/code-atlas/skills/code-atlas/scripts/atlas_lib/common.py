"""Shared filesystem and Git boundaries for the atlas commands."""

from __future__ import annotations

import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tempfile
from datetime import datetime, timezone
from uuid import uuid4


class AtlasError(Exception):
    """An actionable command error that may be shown without a traceback."""


def output_path(path: Path) -> Path:
    """Resolve normal Windows short names, but reject linked output ancestors."""
    path = Path(path).absolute()
    for candidate in (path, *path.parents):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0):
            raise AtlasError('Output cannot traverse a symlink or junction.')
    return path.resolve()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path: Path):
    path = Path(path)
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise AtlasError(f"JSON 格式錯誤：{path.name}（第 {exc.lineno} 行）") from exc
    except (OSError, UnicodeError) as exc:
        raise AtlasError(f"無法讀取 UTF-8 JSON：{path}") from exc


def write_json(path: Path, data, backup: bool = True) -> None:
    """Write atomically, saving the previous bytes before replacing a file."""
    path = Path(path)
    payload = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and backup:
        backups = path.parent / ".backups"
        backups.mkdir(exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        shutil.copy2(path, backups / f"{path.name}.{stamp}.{uuid4().hex[:8]}.bak")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=path.parent, prefix=".atlas-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(payload)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def resolve_source(root: Path, relative: str) -> Path:
    """Only accept portable project-relative paths, including through symlinks."""
    if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative:
        raise AtlasError("程式路徑必須是使用 / 分隔的專案相對路徑")
    portable = PurePosixPath(relative)
    if portable.is_absolute() or ".." in portable.parts:
        raise AtlasError("程式路徑不可超出專案根目錄")
    root = Path(root).resolve()
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root):
        raise AtlasError("程式路徑不可透過連結超出專案根目錄")
    return candidate


def load_context(atlas_dir: Path, project_root: Path | None = None) -> tuple[dict, Path]:
    atlas_dir = Path(atlas_dir).resolve()
    config = read_json(atlas_dir / "config.json")
    if not isinstance(config, dict):
        raise AtlasError("config.json 必須是 JSON 物件")
    configured = config.get("projectRoot")
    if not isinstance(configured, str) or not configured.strip():
        raise AtlasError("config.json 缺少 projectRoot")
    root = Path(project_root).resolve() if project_root is not None else (atlas_dir / configured).resolve()
    if not root.is_dir():
        raise AtlasError(f"專案根目錄不存在：{root}")
    return config, root


def _git(root: Path, arguments: list[str], allow_unborn: bool = False) -> str:
    try:
        result = subprocess.run(["git", "-C", str(Path(root).resolve()), *arguments],
                                capture_output=True, encoding="utf-8", errors="replace", check=False)
    except OSError as exc:
        raise AtlasError("無法執行 Git，請確認已安裝並加入 PATH") from exc
    if result.returncode:
        if allow_unborn:
            # Distinguish an unborn repository from a non-repository or Git failure.
            _git(root, ["rev-parse", "--git-dir"])
            return ""
        raise AtlasError("無法讀取 Git 專案；請確認 project-root 位於 Git 工作目錄內")
    return result.stdout


def git_files(root: Path) -> list[str]:
    paths = _git(root, ["ls-files", "--cached", "-z", "--", "."]).split("\0")
    return sorted(set(path for path in paths if path))


def git_commit(root: Path) -> str:
    return _git(root, ["rev-parse", "--verify", "HEAD"], allow_unborn=True).strip()
