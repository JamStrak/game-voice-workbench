"""Build a public source/Windows ZIP from an explicit allowlist, never developer data."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

VERSION = "0.1.0-beta.1"
ROOT = Path(__file__).resolve().parents[1]
SKIP_PARTS = {".git", ".github", ".claude", ".idea", ".vscode", "node_modules", "__pycache__",
              ".pytest_cache", "dist", "build", "target", "frontend", ".venv", ".venv-emotion"}
SKIP_NAMES = {".mcp.json", ".env", ".env.local", ".DS_Store", "Thumbs.db", "AGENTS.md"}
SCRIPTS = {
    "launch.py", "server.py", "resource_guard.py", "inference_worker.py", "emotion_worker.py",
    "emotion_resources.py", "emotion_compat.py", "setup_emotion.py", "setup_windows.ps1",
    "setup_distribution.py", "distribution_manifest.json", "build_distribution.py",
    "build_voice_library.py", "voice_library_worker.py", "validate_playback.py", "validate_distribution.py",
}
ROOT_FILES = {"local_config.example.json", "requirements-local.txt", "requirements-lock.txt",
              "打开配音工作台.vbs", "关闭配音工作台.vbs", "安装配音工作台.vbs", "安装情绪引擎.vbs"}
PUBLIC_FILES = {"README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md",
                "CONTRIBUTING.md", "SECURITY.md", ".gitignore", ".gitattributes"}
PRIVATE_PREFIXES = ("logs/", "cache/", "models/", "runtime/", ".venv/", ".venv-emotion/",
                    "validation/", "publish/", "试听样音/")
SECRET_PATTERNS = [re.compile(p) for p in (
    r"(?:ghp_|github_pat_|gho_)[A-Za-z0-9_]{24,}",
    r"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----",
    r"(?:sk-proj-|sk-ant-)[A-Za-z0-9_-]{32,}",
    r"[A-Z]:[\\/](?:Users[\\/]Jam|AI新项目[\\/]商业化工作)",
)]


def safe_file(path: Path, base: Path) -> bool:
    relative = path.relative_to(base)
    return (path.is_file() and not path.is_symlink() and
            not set(relative.parts) & SKIP_PARTS and path.name not in SKIP_NAMES and
            path.suffix.lower() not in {".pyc", ".pyo", ".log", ".db", ".sqlite", ".sqlite3", ".exe", ".dll"})


def source_files(base: Path):
    """Include tracked upstream sources plus local adaptations; never include Git history."""
    if (base / ".git").exists():
        names = subprocess.check_output(
            ["git", "-C", str(base), "ls-files", "--cached", "--others", "--exclude-standard", "-z"]
        ).decode("utf-8").split("\0")
        candidates = (base / name for name in names if name)
    else:
        candidates = base.rglob("*")
    for path in sorted(set(candidates)):
        if safe_file(path, base):
            yield path


def audit(folder: Path) -> dict:
    files = []
    for path in sorted(folder.rglob("*")):
        if not path.is_file() or ".git" in path.relative_to(folder).parts:
            continue
        relative = path.relative_to(folder).as_posix()
        if relative == "distribution-files.json":
            continue  # The manifest lists content files, never a self-referential hash.
        if path.is_symlink() or relative.startswith(PRIVATE_PREFIXES):
            raise ValueError(f"Private or linked file in distribution: {relative}")
        if relative == "local_config.json" or (relative.startswith("data/") and not relative.startswith("data/voice-library/")):
            raise ValueError(f"Local configuration/user data in distribution: {relative}")
        if path.stat().st_size >= 90 * 1024 * 1024:
            raise ValueError(f"File too large for source publication: {relative}")
        payload = path.read_bytes()
        if path.suffix.lower() not in {".wav", ".png", ".webp", ".jpg", ".jpeg", ".ico", ".icns", ".woff", ".woff2", ".webm", ".pdf"}:
            text = payload.decode("utf-8-sig", errors="replace")
            if any(pattern.search(text) for pattern in SECRET_PATTERNS):
                raise ValueError(f"Potential credential/private machine path: {relative}")
        files.append({"path": relative, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()})
    return {"version": VERSION, "file_count": len(files), "total_bytes": sum(x["bytes"] for x in files), "files": files}


def build(source: Path, destination: Path) -> dict:
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("Output must be a new or empty directory; existing data is never removed.")
    if destination.resolve() == source.resolve():
        raise ValueError("Output cannot replace the working project.")
    destination.mkdir(parents=True, exist_ok=True)

    def copy(path: Path, relative: Path | str):
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"Missing or linked distribution input: {path.name}")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        # Upstream .gitattributes requires LF for these files. Canonicalize before
        # hashing so a GitHub source ZIP matches the same published manifest.
        if target.relative_to(destination).as_posix().startswith("upstream/voicebox/") and (
                target.name == "package.json" or target.suffix == ".sh"):
            target.write_bytes(target.read_bytes().replace(b"\r\n", b"\n"))

    overlay = source / "distribution" if (source / "distribution").is_dir() else source
    for name in ROOT_FILES:
        copy(source / name, name)
    for name in PUBLIC_FILES:
        copy(overlay / name, name)
    for sub in ("docs", "licenses", ".github"):
        if (overlay / sub).exists():
            for path in (overlay / sub).rglob("*"):
                if path.is_file():
                    copy(path, path.relative_to(overlay))
    for name in SCRIPTS:
        copy(source / "scripts" / name, Path("scripts") / name)
    for path in (source / "tests").glob("*"):
        if path.suffix in {".py", ".cjs"}:
            copy(path, Path("tests") / path.name)
    for name in ("voicebox",):
        base = source / "upstream" / name
        for path in source_files(base):
            relative = path.relative_to(base)
            # Unrelated upstream demo recordings and marketing images are not product assets.
            if name == "voicebox" and (relative.parts[0] in {"docs", "landing"} and len(relative.parts) > 1 and
                                       relative.as_posix() != "landing/package.json"):
                continue
            copy(path, Path("upstream") / name / relative)
    frontend = source / "upstream/voicebox/web/dist"
    if not (frontend / "index.html").is_file():
        frontend = source / "upstream/voicebox/frontend"
    for path in frontend.rglob("*"):
        if path.is_file():
            copy(path, Path("upstream/voicebox/frontend") / path.relative_to(frontend))
    for path in (source / "runtime-emotion").glob("requirements*.txt"):
        copy(path, Path("runtime-emotion") / path.name)
    copy(source / "runtime-emotion/check_import.py", "runtime-emotion/check_import.py")
    for path in (source / "runtime-emotion/metadata").glob("*.json"):
        copy(path, Path("runtime-emotion/metadata") / path.name)
    library = source / "data/voice-library"
    catalog = json.loads((library / "catalog.json").read_text(encoding="utf-8-sig"))
    copy(library / "catalog.json", "data/voice-library/catalog.json")
    for voice in catalog["voices"]:
        for sample in voice["samples"]:
            path = (library / "audio" / sample["audio_path"]).resolve()
            if not path.is_relative_to((library / "audio").resolve()):
                raise ValueError("Preview path leaves the built-in library.")
            if hashlib.sha256(path.read_bytes()).hexdigest() != sample["sha256"]:
                raise ValueError(f"Preview checksum mismatch: {voice['id']}/{sample['id']}")
            copy(path, Path("data/voice-library/audio") / sample["audio_path"])
    report = audit(destination)
    (destination / "distribution-files.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def archive(folder: Path, target: Path):
    if target.exists():
        raise ValueError("ZIP already exists; use a new output filename.")
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for path in sorted(folder.rglob("*")):
            if path.is_file() and ".git" not in path.relative_to(folder).parts:
                bundle.write(path, Path("game-voice-workbench") / path.relative_to(folder))
    return hashlib.sha256(target.read_bytes()).hexdigest()


def verify_manifest(folder: Path) -> dict:
    manifest = json.loads((folder / "distribution-files.json").read_text(encoding="utf-8"))
    for entry in manifest["files"]:
        path = (folder / entry["path"]).resolve()
        if not path.is_relative_to(folder.resolve()):
            raise ValueError("Manifest path escapes distribution.")
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError(f"Distribution checksum mismatch: {entry['path']}")
    return {"verified_files": len(manifest["files"]), "version": manifest["version"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--audit", type=Path)
    parser.add_argument("--verify", type=Path)
    parser.add_argument("--zip", type=Path)
    args = parser.parse_args()
    if args.verify:
        print(json.dumps(verify_manifest(args.verify), ensure_ascii=False))
        return
    if args.audit:
        result = audit(args.audit)
    elif args.output:
        result = build(args.source.resolve(), args.output.resolve())
    else:
        parser.error("Use --output NEW_DIRECTORY or --audit DIRECTORY")
    summary = {k: v for k, v in result.items() if k != "files"}
    if args.zip:
        summary["zip_sha256"] = archive(args.audit or args.output, args.zip)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
