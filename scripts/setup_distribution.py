"""Pinned, resumable public-model downloads for the Windows installer (stdlib only)."""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
from pathlib import Path
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def safe_path(root: Path, relative: str) -> Path:
    result = (root / relative).resolve()
    if not result.is_relative_to(root.resolve()):
        raise ValueError(f"Unsafe distribution path: {relative}")
    return result


def verify(path: Path, item: dict) -> bool:
    if not path.is_file() or path.stat().st_size != item["size"]:
        return False
    digest = hashlib.sha256() if item.get("sha256") else hashlib.sha1()
    if not item.get("sha256"):
        digest.update(f"blob {item['size']}\0".encode())
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == (item.get("sha256") or item["git_blob"])


def download(url: str, destination: Path, item: dict, *, open_url=urllib.request.urlopen,
             sleep=time.sleep, attempts=5, fallback_urls=()) -> None:
    """Resume bounded ranges; a server ignoring Range safely restarts the same file."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if verify(destination, item):
        print(f"已校验，跳过：{destination.name}", flush=True)
        return
    partial = destination.with_name(destination.name + ".part")
    sources = (url, *fallback_urls)
    for attempt in range(attempts):
        try:
            active_url = sources[attempt % len(sources)]
            print(f"下载来源：{urllib.parse.urlsplit(active_url).hostname}", flush=True)
            offset = partial.stat().st_size if partial.exists() else 0
            if offset >= item["size"]:
                if verify(partial, item):
                    partial.replace(destination)
                    return
                partial.unlink()
                offset = 0
            while offset < item["size"]:
                end = min(offset + 16 * 1024 * 1024, item["size"]) - 1
                request = urllib.request.Request(active_url, headers={
                    "User-Agent": "voice-workbench-installer/1.0",
                    "Range": f"bytes={offset}-{end}",
                })
                with open_url(request, timeout=90) as response:
                    status = response.status
                    if status not in (200, 206):
                        raise RuntimeError(f"下载返回 HTTP {status}")
                    if status == 206:
                        expected = f"bytes {offset}-"
                        if not response.headers.get("Content-Range", "").startswith(expected):
                            raise RuntimeError("服务器返回的续传位置不一致，请重新下载")
                    elif offset:
                        offset = 0
                    with partial.open("ab" if offset else "wb") as output:
                        for chunk in iter(lambda: response.read(256 * 1024), b""):
                            output.write(chunk)
                            if output.tell() > item["size"]:
                                raise RuntimeError("下载大小超过固定清单")
                latest = partial.stat().st_size
                if latest <= offset:
                    raise RuntimeError("下载未返回数据")
                offset = latest
                print(f"下载 {destination.name}：{offset / 1048576:.1f} / "
                      f"{item['size'] / 1048576:.1f} MB", flush=True)
            if not verify(partial, item):
                partial.unlink()
                raise RuntimeError("下载内容校验失败，已清理损坏的临时文件")
            partial.replace(destination)
            return
        except (OSError, ValueError, RuntimeError, urllib.error.URLError, http.client.IncompleteRead) as exc:
            if attempt + 1 == attempts:
                raise RuntimeError(f"{destination.name} 下载失败：{exc}。"
                                   "检查网络后重新运行安装器，完整文件与续传文件会保留。") from exc
            print(f"下载重试 {attempt + 1}/{attempts}：{exc}", flush=True)
            sleep(2 * (attempt + 1))


def install_models(root: Path, manifest: dict, model_cache: Path | None = None) -> None:
    verified_files: dict[str, Path] = {}
    for model in manifest["models"]:
        directory = safe_path(root, model["directory"])
        print(f"准备 {model['repo']} @ {model['revision']}", flush=True)
        for item in model["files"]:
            target = safe_path(directory, item["path"])
            digest = item.get("sha256") or item["git_blob"]
            source = verified_files.get(digest)
            if source is None and model_cache:
                candidate = safe_path(model_cache, Path(model["directory"]).name + "/" + item["path"])
                if verify(candidate, item):
                    source = candidate
            if not verify(target, item) and source:
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_name(target.name + ".part")
                shutil.copyfile(source, temporary)
                if not verify(temporary, item):
                    raise RuntimeError(f"本地模型缓存校验失败：{item['path']}")
                temporary.replace(target)
                print(f"复用已校验模型文件：{item['path']}", flush=True)
            url = (f"https://huggingface.co/{model['repo']}/resolve/{model['revision']}/"
                   f"{urllib.parse.quote(item['path'], safe='/')}?download=true")
            mirrors = [mirror["url"] for mirror in item.get("mirrors", [])
                       if item.get("sha256") and mirror.get("sha256") == item["sha256"]]
            download(url, target, item, fallback_urls=mirrors)
            verified_files[digest] = target
        (directory / "distribution-verified.json").write_text(
            json.dumps({"repo": model["repo"], "revision": model["revision"],
                        "files": model["files"]}, ensure_ascii=False, indent=2), encoding="utf-8")


def init_config(root: Path) -> None:
    target = root / "local_config.json"
    if not target.exists():
        content = json.loads((root / "local_config.example.json").read_text(encoding="utf-8-sig"))
        # Never copy a maintainer's private configuration into a fresh installation.
        content["resource_guard"] = None
        content["emotion_ready"] = content["emotion_analyzer_ready"] = False
        target.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")


def complete_emotion(root: Path) -> None:
    init_config(root)
    target = root / "local_config.json"
    content = json.loads(target.read_text(encoding="utf-8-sig"))
    expected_model = root / "models/indextts-2.5"
    actual_model = (root / content.get("emotion_model", "models/indextts-2.5")).resolve()
    if actual_model != expected_model.resolve():
        raise RuntimeError("现有配置使用其他情绪模型目录，安装器不会覆盖。请先检查 local_config.json。")
    if not (expected_model / "verified-manifest.json").is_file():
        raise RuntimeError("情绪模型尚未完整校验，保留为未就绪状态。")
    content["emotion_ready"] = content["emotion_analyzer_ready"] = True
    temporary = target.with_suffix(".json.part")
    temporary.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["models", "init", "emotion-complete", "list", "check-base", "check-cuda"])
    parser.add_argument("--model-cache", type=Path)
    args = parser.parse_args()
    manifest = json.loads((ROOT / "scripts/distribution_manifest.json").read_text(encoding="utf-8-sig"))
    if args.action == "models":
        install_models(ROOT, manifest, args.model_cache)
    elif args.action == "init":
        init_config(ROOT)
    elif args.action == "emotion-complete":
        complete_emotion(ROOT)
    elif args.action == "check-base":
        import importlib
        import faulthandler
        faulthandler.dump_traceback_later(90, repeat=True)
        try:
            for name in ("torch", "torchaudio", "qwen_tts", "fastapi", "sqlalchemy", "soundfile"):
                print(f"检查运行依赖：{name}", flush=True)
                module = importlib.import_module(name)
                print(f"已就绪：{name} {getattr(module, '__version__', '')}", flush=True)
        finally:
            faulthandler.cancel_dump_traceback_later()
        print("基础环境导入检查通过（未加载模型）", flush=True)
    elif args.action == "check-cuda":
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError("未检测到可用的 NVIDIA CUDA 环境。请更新 NVIDIA 显卡驱动后重试，或选择仅试听模式。")
        print(torch.cuda.get_device_name(0), flush=True)
    else:
        print(json.dumps({"models": [{"repo": m["repo"], "revision": m["revision"],
                                      "bytes": sum(f["size"] for f in m["files"])}
                                     for m in manifest["models"]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
