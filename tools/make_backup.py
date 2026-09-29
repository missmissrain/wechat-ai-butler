"""给当前项目做一份版本备份（源码 + 配置 + 构建产物 + 指纹）。

背景：这个项目历史上靠一串 `make_backup_vNN.py` 一次性脚本堆版本，散落在系统临时目录里、
把本机绝对路径写得到处都是。这里收成一个**参数化**脚本放进项目内。

会**自动排除**：node_modules（可 npm install 重装）、运行日志、备份目录自身、审计产物。

用法：
    python tools/make_backup.py v3.6 "控制台与可靠性修复"
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
HARNESS = PROJECT.parent / "deepseek-harness"
BACKUP_ROOT = PROJECT.parent / "备份"
PRESET = Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh")) / ".agent-presets" / "weixin-lite"

EXCLUDE_DIRS = {"node_modules", ".cache", "__pycache__", ".git", "备份", "审计产物"}
EXCLUDE_FILES = {"electron.log", "electron-out.log", "electron-run.log"}

# 项目里要收进备份的部分
INCLUDE_DIRS = ["config", "console", "docs", "tools"]
INCLUDE_FILES = ["start_stack.py", "switch_model.py", "weixin_login.py",
                 "start.cmd", "start-harness.cmd", "start-login.cmd", "AGENTS.md", "README.md"]
# harness 里我们自己写的包
HARNESS_PARTS = [
    "packages/webhook/webhook-weixin/src",
    "packages/webhook/webhook-weixin/tests",
    "packages/webhook/webhook-weixin/lib",
    "packages/webhook/tool-codex/src",
    "packages/webhook/tool-opencode/src",
    "packages/compaction/compaction-basic/src",
    "packages/compaction/compaction-basic/lib",
]


def copy_filtered(source: Path, target: Path) -> None:
    """复制目录，跳过排除项。"""
    for root, dirs, files in os.walk(source):
        dirs[:] = [name for name in dirs if name not in EXCLUDE_DIRS]
        relative = os.path.relpath(root, source)
        destination = target if relative == "." else target / relative
        destination.mkdir(parents=True, exist_ok=True)
        for name in files:
            if name in EXCLUDE_FILES:
                continue
            shutil.copy2(Path(root) / name, destination / name)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("用法：python tools/make_backup.py <版本号，如 v3.6> <标题>")
        return 1
    version, title = argv[0], argv[1]
    target = BACKUP_ROOT / ("智能秘书%s-%s" % (version, title))
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)

    for name in INCLUDE_FILES:
        source = PROJECT / name
        if source.is_file():
            shutil.copy2(source, target / name)
    for name in INCLUDE_DIRS:
        source = PROJECT / name
        if source.is_dir():
            copy_filtered(source, target / name)
    if PRESET.is_dir():
        copy_filtered(PRESET, target / "presets" / "weixin-lite")
    for part in HARNESS_PARTS:
        source = HARNESS / part
        if source.is_dir():
            copy_filtered(source, target / part.replace("/", "_"))

    hashes = {}
    for root, _dirs, files in os.walk(target):
        for name in files:
            path = Path(root) / name
            hashes[str(path.relative_to(target))] = hashlib.sha256(path.read_bytes()).hexdigest()[:16]

    record = {
        "version": version,
        "title": title,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "file_count": len(hashes),
        "note": "已排除 node_modules（Electron 本体）与运行日志；恢复时在 console 目录执行 npm install。",
        "sha256_prefix": hashes,
    }
    (target / "版本记录.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        status = subprocess.run(["git", "-C", str(HARNESS), "status", "--short"],
                                capture_output=True, text=True, timeout=60).stdout
        (target / "git-status.txt").write_text(status, encoding="utf-8")
    except (OSError, subprocess.SubprocessError):
        pass

    size = sum(path.stat().st_size for path in target.rglob("*") if path.is_file())
    print("备份完成：%s" % target)
    print("文件数 %d，大小 %.2f MB" % (len(hashes), size / 1024 / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
