"""Fetch pinned IndexTTS 2.5 inference assets and verify repository hashes.

Run with the existing project Python (stdlib only). Does not install anything,
load a model, use CUDA, or touch a global cache. Metadata is frozen under
runtime-emotion/metadata; every downloaded file is checked against it.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "models/indextts-2.5"
META = ROOT / "runtime-emotion/metadata"
PINNED = {
    "IndexTeam/IndexTTS-2.5": "c39ce5ba981572cb187443877ff559dfb246ce63",
    "facebook/w2v-bert-2.0": "da985ba0987f70aaeb84a80f2851cfac8c697a7b",
    "funasr/campplus": "e4b6ede7ce16997aff4ae69fbca1f0175e2afede",
    "nvidia/bigvgan_v2_22khz_80band_256x": "633ff708ed5b74903e86ff1298cf4a98e921c513",
}
MIRRORS = {
    "IndexTeam/IndexTTS-2.5": ("IndexTeam/IndexTTS-2.5", "modelscope-index.json"),
    "facebook/w2v-bert-2.0": ("AI-ModelScope/w2v-bert-2.0", "modelscope-AI-ModelScope--w2v-bert-2.0.json"),
    "funasr/campplus": ("iic/speech_campplus_sv_zh-cn_16k-common", "modelscope-iic--speech_campplus_sv_zh-cn_16k-common.json"),
}


def tasks(include_analysis=True):
    result = []
    for repo, revision in PINNED.items():
        metadata = json.loads((META / (repo.replace("/", "--") + ".json")).read_text(encoding="utf-8-sig"))
        if metadata["sha"] != revision:
            raise ValueError(f"Wrong frozen revision for {repo}")
        for item in metadata["siblings"]:
            name = item["rfilename"]
            if repo.startswith("IndexTeam/"):
                if name == ".gitattributes" or (name.startswith("qwen") and not include_analysis):
                    continue
                relative = name
            elif repo.startswith("facebook/"):
                if name not in {"config.json", "model.safetensors", "preprocessor_config.json", "README.md"}:
                    continue
                relative = "hf_cache/w2v-bert-2.0/" + name
            elif repo.startswith("funasr/"):
                if name not in {"campplus_cn_common.bin", "README.md"}:
                    continue
                relative = "hf_cache/" + (name if name.endswith(".bin") else "CAMPPlus-README.md")
            else:
                if name not in {"config.json", "bigvgan_generator.pt", "LICENSE", "README.md"}:
                    continue
                relative = "hf_cache/bigvgan/" + name
            result.append(dict(repo=repo, revision=revision, remote=name, path=relative,
                               size=item["size"], sha256=item.get("lfs", {}).get("sha256"),
                               git_blob=item["blobId"]))
    return result


def verify(path, item):
    if not path.is_file() or path.stat().st_size != item["size"]:
        return None
    sha = hashlib.sha256()
    blob = hashlib.sha1(f"blob {item['size']}\0".encode())
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            sha.update(block)
            blob.update(block)
    if item["sha256"]:
        if sha.hexdigest() != item["sha256"]:
            return None
    elif blob.hexdigest() != item["git_blob"]:
        return None
    return sha.hexdigest()


def download(item):
    destination = MODEL / item["path"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    verified = verify(destination, item)
    if verified:
        print("verified existing", item["path"], flush=True)
        return dict(item, actual_sha256=verified)
    partial = destination.with_name(destination.name + ".part")
    url = f"https://huggingface.co/{item['repo']}/resolve/{item['revision']}/{item['remote']}?download=true"
    mirror = MIRRORS.get(item["repo"])
    if mirror and item["sha256"]:
        entries = json.loads((META / mirror[1]).read_text(encoding="utf-8-sig"))["Data"]["Files"]
        matched = next((x for x in entries if x["Path"] == item["remote"] and x.get("Sha256") == item["sha256"]), None)
        if matched:
            url = f"https://modelscope.cn/models/{mirror[0]}/resolve/{matched['Revision']}/{item['remote']}"
            item = dict(item, transport_repo=mirror[0], transport_revision=matched["Revision"])
    for attempt in range(5):
        offset = partial.stat().st_size if partial.exists() else 0
        if offset >= item["size"]:
            verified = verify(partial, item)
            if verified:
                partial.replace(destination)
                return dict(item, actual_sha256=verified)
            partial.unlink()
            offset = 0
        headers = {"User-Agent": "voice-workbench-pinned-installer/1.0"}
        try:
            print("download", item["path"], "offset", offset, "bytes", item["size"], flush=True)
            while offset < item["size"]:
                end = min(offset + 16 * 1024 * 1024, item["size"]) - 1
                headers["Range"] = f"bytes={offset}-{end}"
                chunk_url = url + ("&" if "?" in url else "?") + f"segment={offset}"
                with urllib.request.urlopen(urllib.request.Request(chunk_url, headers=headers), timeout=45) as response:
                    if offset and response.status != 206:
                        raise RuntimeError("Server refused resumable range")
                    with partial.open("ab" if offset else "wb") as output:
                        for chunk in iter(lambda: response.read(256 * 1024), b""):
                            output.write(chunk)
                latest = partial.stat().st_size
                if latest <= offset:
                    raise RuntimeError("Server returned no download data")
                offset = latest
                if offset > item["size"]:
                    partial.unlink()
                    raise RuntimeError("Downloaded file larger than frozen metadata")
            verified = verify(partial, item)
            if not verified:
                partial.unlink()
                raise RuntimeError(f"Hash/size mismatch: {item['path']}")
            partial.replace(destination)
            print("verified downloaded", item["path"], flush=True)
            return dict(item, actual_sha256=verified)
        except Exception as error:
            print("retry", attempt + 1, item["path"], type(error).__name__, str(error), flush=True)
            if attempt == 4:
                raise
            time.sleep(2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--without-analysis", action="store_true")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    selected = tasks(not args.without_analysis)
    print(json.dumps({"files": len(selected), "bytes": sum(x["size"] for x in selected),
                      "revisions": PINNED}, ensure_ascii=False), flush=True)
    if args.list:
        return
    results = []
    with ThreadPoolExecutor(max_workers=3) as executor:
        for future in as_completed([executor.submit(download, item) for item in selected]):
            results.append(future.result())
    manifest = {"source_revision": "ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c",
                "model_revisions": PINNED, "files": sorted(results, key=lambda x: x["path"]),
                "downloaded_bytes": sum(x["size"] for x in selected)}
    (MODEL / "verified-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print("ALL ASSETS VERIFIED", flush=True)


if __name__ == "__main__":
    main()
