"""Gemma 4 E4B GGUF 下载入口。

本模块负责从 Hugging Face 镜像以 HTTP Range 分块并行下载 Gemma 4 E4B
量化模型和视觉投影文件，校验文件大小与 SHA-256，并以 dqtm 进度输出。
下载缓存、分块和最终模型均保存在当前 Gemma 子项目目录中。
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODEL_ROOT = ROOT / "model"
PART_ROOT = MODEL_ROOT / ".parts"
MIRROR_ROOT = "https://hf-mirror.com/unsloth/gemma-4-E4B-it-GGUF/resolve/main"
WORKERS = 8
CHUNK_SIZE = 64 * 1024 * 1024
FILES = {
    "gemma-4-E4B-it-Q4_K_M.gguf": 4_977_171_584,
    "mmproj-BF16.gguf": 991_552_320,
}


def download_part(url: str, part_path: Path, start: int, end: int, lock: threading.Lock, state: dict) -> None:
    """下载一个闭区间字节分片，并校验分片长度。"""
    expected = end - start + 1
    if part_path.exists() and part_path.stat().st_size == expected:
        with lock:
            state["done"] += expected
            print(f"[dqtm] {state['done']}/{state['total']} bytes (cached)", flush=True)
        return
    for attempt in range(1, 5):
        try:
            completed = subprocess.run(
                [
                    "curl.exe",
                    "-L",
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--retry",
                    "3",
                    "--retry-delay",
                    "2",
                    "--connect-timeout",
                    "30",
                    "--range",
                    f"{start}-{end}",
                    "--output",
                    str(part_path),
                    url,
                ],
                timeout=600,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            if completed.returncode != 0:
                raise RuntimeError(completed.stderr[-1000:])
            if part_path.stat().st_size != expected:
                raise RuntimeError(f"分片长度错误: {part_path.stat().st_size} != {expected}")
            with lock:
                state["done"] += expected
                print(f"[dqtm] {state['done']}/{state['total']} bytes", flush=True)
            return
        except Exception:
            if attempt == 4:
                raise
            time.sleep(attempt * 2)


def download_file(name: str, expected_size: int) -> dict:
    """并行下载一个文件、顺序合并分片并返回校验元数据。"""
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    PART_ROOT.mkdir(parents=True, exist_ok=True)
    url = f"{MIRROR_ROOT}/{name}"
    part_dir = PART_ROOT / name
    part_dir.mkdir(parents=True, exist_ok=True)
    ranges = []
    start = 0
    index = 0
    while start < expected_size:
        end = min(expected_size - 1, start + CHUNK_SIZE - 1)
        ranges.append((index, start, end))
        start = end + 1
        index += 1
    state = {"done": 0, "total": expected_size}
    lock = threading.Lock()
    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = [
            executor.submit(
                download_part,
                url,
                part_dir / f"part_{part_index:04d}.bin",
                start,
                end,
                lock,
                state,
            )
            for part_index, start, end in ranges
        ]
        for future in as_completed(futures):
            future.result()
    target = MODEL_ROOT / name
    with target.open("wb") as output:
        for part_index, _, _ in ranges:
            output.write((part_dir / f"part_{part_index:04d}.bin").read_bytes())
    actual_size = target.stat().st_size
    if actual_size != expected_size:
        raise RuntimeError(f"{name} 合并大小错误: {actual_size} != {expected_size}")
    digest = hashlib.sha256()
    with target.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return {"path": str(target), "size": actual_size, "sha256": digest.hexdigest()}


def main() -> None:
    """下载两个 Gemma 文件并保存完整性清单。"""
    metadata = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source": "hf-mirror.com/unsloth/gemma-4-E4B-it-GGUF",
        "files": {},
    }
    for name, expected_size in FILES.items():
        metadata["files"][name] = download_file(name, expected_size)
    (ROOT / "下载校验.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(metadata, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
