"""Start a local installation, verify its UI/API/previews, then stop only our own server.

No model loading, speech generation, cloud calls or private-data uploads.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("release_launch", ROOT / "scripts/launch.py")
    launcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(launcher)
    existing = launcher.find_existing(ROOT, launcher.candidate_ports(ROOT))
    url = launcher.start(ROOT)
    checks = {"url": url, "reused_existing_server": existing is not None, "model_loading": False}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def get(path):
        with opener.open(url.rstrip("/") + path, timeout=20) as response:
            return response.status, response.headers.get("content-type", ""), response.read()

    try:
        status, _, raw = get("/local/identity")
        identity = json.loads(raw)
        assert status == 200 and launcher.compatible(identity, ROOT), identity
        checks["pid"] = identity.get("pid")
        checks["pages"] = {}
        for path in ("/", "/voices", "/workbench", "/models", "/settings"):
            status, mime, raw = get(path)
            assert status == 200 and "text/html" in mime and b'id="root"' in raw, path
            checks["pages"][path] = status
        status, _, raw = get("/models/status")
        model_status = json.loads(raw)
        assert status == 200 and len(model_status["models"]) == 2, model_status
        checks["model_status"] = model_status
        # Exactly the same launcher must reuse this root and PID.
        assert launcher.start(ROOT) == url
        _, _, raw = get("/local/identity")
        assert json.loads(raw)["pid"] == checks["pid"]
        checks["launcher_reuse"] = True
        playback_output = args.output.with_name(args.output.stem + "-playback.json")
        subprocess.run([sys.executable, str(ROOT / "scripts/validate_playback.py"),
                        "--base", url.rstrip("/"), "--output", str(playback_output)], check=True)
        checks["playback_report"] = playback_output.name
        checks["success"] = True
    finally:
        if existing is None:
            checks["owned_server_stopped"] = launcher.stop(ROOT)
        args.output.write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(checks, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
