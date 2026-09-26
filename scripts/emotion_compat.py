"""Windows native path compatibility without modifying installed packages.

Call after chdir into the project cache, before importing IndexTTS. Some C++
readers use narrow fopen and cannot open the Chinese absolute project path;
ASCII relative paths resolve to the exact same files with the Unicode CWD.
Keep that CWD unchanged throughout inference.
"""
from __future__ import annotations

import importlib.resources
import os
from pathlib import Path


def prepare_native_paths():
    if os.name != "nt":
        return
    original_files = importlib.resources.files

    def relative_files(package):
        if package == "wetext.fsts":
            # fsts is a namespace package; its Traversable is a MultiplexedPath,
            # whose string form is a repr rather than a usable filesystem path.
            resource = original_files("wetext").joinpath("fsts")
            path = Path(os.path.relpath(str(resource), Path.cwd()))
            if not str(path).isascii():
                raise RuntimeError("请从配音工作台的项目缓存目录运行情绪引擎。")
            return path
        return original_files(package)

    importlib.resources.files = relative_files
    try:
        import wetext  # noqa: F401; freezes FST path mapping for this process
    finally:
        importlib.resources.files = original_files

    # Fugashi's auto-discovery reads this variable before constructing MeCab.
    import unidic_lite
    dictionary = os.path.relpath(unidic_lite.DICDIR, Path.cwd())
    if not dictionary.isascii():
        raise RuntimeError("日语字典需要项目内的 ASCII 相对路径。")
    unidic_lite.DICDIR = dictionary
