"""Local, windowless launcher. Run through the root VBS shortcuts."""
from __future__ import annotations

import argparse
import contextlib
import ctypes
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "upstream/voicebox"))
from backend.services.local_runtime import load_configuration
STARTUP_TIMEOUT = 180.0
LOCK_TIMEOUT = 210.0
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class LaunchError(RuntimeError):
    pass


def same_root(value: str, root: Path) -> bool:
    return os.path.normcase(os.path.realpath(value)) == os.path.normcase(str(root.resolve()))


def identity(port: int) -> dict | None:
    try:
        with OPENER.open(f"http://127.0.0.1:{port}/local/identity", timeout=0.4) as response:
            result = json.loads(response.read(65536))
        return result if isinstance(result, dict) else None
    except (OSError, ValueError, urllib.error.URLError):
        return None


def compatible(info: dict | None, root: Path) -> bool:
    return bool(info and info.get("app") == "voice-workbench"
                and isinstance(info.get("root"), str) and same_root(info["root"], root))


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if os.name == "nt":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def candidate_ports(root: Path) -> list[int]:
    try:
        config = load_configuration(root)
        preferred = int(config.get("preferred_port", 23164))
        if not 1024 <= preferred <= 65515:
            raise ValueError("invalid port")
    except (OSError, ValueError, TypeError) as exc:
        raise LaunchError("无法读取 local_config.json 的端口设置。请恢复该文件后重试。") from exc
    ports = list(range(preferred, preferred + 20))
    try:
        recorded = json.loads((root / "data/server.json").read_text(encoding="utf-8"))
        saved_port = recorded.get("port")
        if type(saved_port) is int and saved_port in ports:
            ports.remove(saved_port)
            ports.insert(0, saved_port)
    except (OSError, ValueError, TypeError):
        pass
    return ports


def find_existing(root: Path, ports: list[int], probe=identity) -> tuple[int, dict] | None:
    for port in ports:
        info = probe(port)
        if compatible(info, root):
            return port, info
    return None


def choose_port(ports: list[int], is_free=port_free) -> int:
    for port in sorted(ports):
        if is_free(port):
            return port
    raise LaunchError("配音工作台的 20 个启动端口均被占用。请关闭多余实例或修改 local_config.json 的 preferred_port 后重试。")


@contextlib.contextmanager
def launch_lock(root: Path, timeout: float = LOCK_TIMEOUT):
    lock_path = root / "data/launcher.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise LaunchError("另一个启动或关闭操作仍在进行，请稍后再次双击。") from exc
                time.sleep(0.2)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def write_record(root: Path, port: int, info: dict) -> None:
    target = root / "data/server.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps({"port": port, "pid": info.get("pid"),
                                     "root": str(root), "app": "voice-workbench"},
                                    ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)


def start(root: Path, timeout: float = STARTUP_TIMEOUT) -> str:
    ports = candidate_ports(root)
    existing = find_existing(root, ports)
    if existing:
        port, info = existing
        write_record(root, port, info)
        return f"http://127.0.0.1:{port}/"
    if (root / "runtime/uv/uv.exe").is_file() and not (root / "data/installation.json").is_file():
        raise LaunchError("上次安装尚未完成。请双击“安装配音工作台.vbs”继续安装，已下载的文件会保留。")
    python = root / ".venv/Scripts/python.exe"
    server = root / "scripts/server.py"
    if not python.is_file():
        raise LaunchError("缺少配音环境 .venv\\Scripts\\python.exe。请先双击“安装配音工作台.vbs”，安装完成后再次打开。")
    if not server.is_file():
        raise LaunchError("缺少 scripts\\server.py，配音工作台文件尚未准备完整。请恢复该文件后重试。")
    port = choose_port(ports)
    log_path = root / "logs/server.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    with log_path.open("ab", buffering=0) as log:
        log.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] 启动端口 {port}\n".encode("utf-8"))
        process = subprocess.Popen([str(python), str(server), "--port", str(port)],
                                   cwd=str(root), stdout=log, stderr=log,
                                   stdin=subprocess.DEVNULL, creationflags=flags)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise LaunchError(f"服务启动失败（退出码 {process.returncode}）。详细原因已保存至 logs\\server.log，请将该日志交给维护者。")
        info = identity(port)
        if compatible(info, root):
            write_record(root, port, info)
            return f"http://127.0.0.1:{port}/"
        time.sleep(0.4)
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
    raise LaunchError("启动超过 3 分钟仍未就绪，已停止本次启动。请查看 logs\\server.log；确认模型文件和独立环境完整后重试。")


def stop(root: Path, timeout: float = 40.0) -> bool:
    existing = find_existing(root, candidate_ports(root))
    if not existing:
        return False
    port, previous = existing
    request = urllib.request.Request(f"http://127.0.0.1:{port}/shutdown", data=b"", method="POST")
    try:
        with OPENER.open(request, timeout=10):
            pass
    except (OSError, urllib.error.URLError) as exc:
        # Some servers close the socket as shutdown completes.
        if compatible(identity(port), root):
            raise LaunchError("关闭请求未完成，请稍后重试。详细信息见 logs\\server.log。") from exc
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        current = identity(port)
        stopped = port_free(port) if current is None else (
            not compatible(current, root) or current.get("pid") != previous.get("pid")
        )
        if stopped:
            (root / "data/server.json").unlink(missing_ok=True)
            return True
        time.sleep(0.5)
    raise LaunchError("服务尚未完成关闭，可能仍在清理生成任务。请稍后再次双击关闭；已完成的声音保留在项目中。")


def message(text: str, error: bool = True) -> None:
    if os.name == "nt":
        ctypes.windll.user32.MessageBoxW(None, text, "配音工作台", 0x10 if error else 0x40)
    else:
        print(text, file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stop", action="store_true")
    args = parser.parse_args()
    try:
        with launch_lock(ROOT):
            if args.stop:
                stop(ROOT)
                return 0
            url = start(ROOT)
        if not webbrowser.open(url):
            raise LaunchError(f"服务已启动，但未能打开浏览器。请在浏览器地址栏打开：{url}")
        return 0
    except Exception as exc:
        text = str(exc) if isinstance(exc, LaunchError) else f"启动或关闭失败：{exc}"
        try:
            path = ROOT / "logs/server.log"
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as log:
                log.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] {text}\n")
        except OSError:
            pass
        message(text)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
