# 参与开发

欢迎提交复现清楚的问题、兼容性报告和改进。请先说明 Windows 版本、显卡/显存、内存、发行版本和操作步骤。

本项目基于 Voicebox 的固定提交，保留其版权和许可；本地适配集中在 `scripts/`、`upstream/voicebox/backend/` 与 `upstream/voicebox/app/`。可选 IndexTTS 源码由安装器从固定上游提交下载，不包含在仓库中。

## 前端

维护者安装 Bun 后，在 `upstream/voicebox` 执行 `bun install --frozen-lockfile`、`bun run typecheck`、`bun run build:web`。普通用户不需要 Bun 或 Node。

前端测试从仓库根目录执行 `node --test tests/*.test.cjs`。构建完成的 `web/dist` 是发行包 `frontend` 的来源。

## Python

使用本项目安装器创建的环境，在根目录执行 `.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"`。不要用系统环境替换独立推理环境，也不要将个人模型路径写进默认配置。

## 构建发行包

在完整源码根目录执行 `python scripts/build_distribution.py --output 新的空目录 --zip 新的发行包.zip`。该脚本只拷贝明确允许的文件、校验内置样音、生成逐文件 SHA256 清单，并阻止本机配置、数据库、模型、缓存和常见凭证进入发行包。

发布前应在新的解压目录运行安装器、检查声音库、生成一条台词、关闭后重开，且保留真实验证范围。不得把运行在开发机上的测试描述为所有用户电脑均已通过。
