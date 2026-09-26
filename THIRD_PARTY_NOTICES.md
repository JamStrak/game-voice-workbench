# 第三方来源与许可

核对日期：2026-09-26。本文件对应配音工作台首次公开发行准备。根目录的软件许可不覆盖所有第三方组件、模型和声音素材；各自的完整许可优先于本摘要。

## 随包源码与前端

| 组件 | 固定版本或来源 | 许可与随包文件 |
| --- | --- | --- |
| Voicebox | `51f49dea198384b4eb6087b72c17057c6eb1c1cd`；[官方源码](https://github.com/jamiepine/voicebox/tree/51f49dea198384b4eb6087b72c17057c6eb1c1cd) | MIT；[完整原文](licenses/Voicebox-MIT.txt)。保留 Voicebox Contributors 原版权。 |
| 配音工作台新增代码 | 当前发行版本的本地启动、中文界面、声音库、表达与批次等修改 | 见根目录 LICENSE；不替代本表的第三方许可。 |
| 前端及构建依赖 | 从此次实际安装的 npm 锁定依赖提取；399 个名称/版本、524 份许可与 notice | [版本及逐文件 SHA256 清单](licenses/npm-manifest.json)，全文在 `licenses/npm/`。包含 React、WaveSurfer、Radix、TanStack、Lucide 等；为防遗漏也保留构建/未捆绑依赖的许可，列入清单不等于其可执行文件被随包分发。 |

少数 npm 包只在包元数据声明许可，未附独立全文。`PACKAGE-DECLARATION.json` 保留真实声明；`dlv`、`keyv`、`react-sound-visualizer`、`sound-visualizer` 的 `DECLARED-LICENSE-TEXT.txt` 是按该声明及作者信息补充的标准文本，清单明确标注，未伪称上游随包原文件。部分同仓库子包补用其项目的实际许可全文；来源亦列在清单。

这是基于 Voicebox 的独立修改版本。第三方名称和标识用于说明来源，不表示原作者为本项目背书。不得删除随文件保留的版权、专利、商标或 attribution 声明。

## 内置试听

`data/voice-library/catalog.json` 给出每段音频的文字、引擎、模型版本、seed 和 SHA256。总计 9 种 Qwen 原生 speaker、36 段人工编写短句的合成 WAV。它们不是用户上传的参考录音，也不是网络采集的样音。

| 范围 | 生成来源 | 使用说明 |
| --- | --- | --- |
| 9 段 `natural.wav` | Qwen3-TTS-12Hz-0.6B-CustomVoice，`85e237c12c027371202489a0ec509ded67b5e4b5` | 模型许可 Apache-2.0，来源见[固定模型卡](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice/blob/85e237c12c027371202489a0ec509ded67b5e4b5/README.md)。本项目将其作为生成示例提供；不将模型的 Apache-2.0 自动等同于对任何生成内容的权利保证。 |
| 27 段 `happy.wav` / `angry.wav` / `sad.wav` | 同 speaker 的自然样音作为参考，经 IndexTTS 2.5 模型 `c39ce5ba981572cb187443877ff559dfb246ce63` 合成 | 适用随附 bilibili 模型使用许可；不属于根 MIT 许可。公开演示、复制、再分发和用途限制均应依完整协议执行。 |

使用这 27 段情绪试听，即须遵守 [IndexTTS 中文协议](licenses/IndexTTS-LICENSE-zh.txt) 与 [英文协议](licenses/IndexTTS-LICENSE-en.txt)，随包另保留[该固定模型的 LICENSE](licenses/IndexTTS-2.5-model-LICENSE.txt)。不接受这些条款时不要使用这些情绪试听；自然试听与源码的适用条款分别说明，不据此扩大 IndexTTS 的授权。

IndexTTS 许可要求下游保留协议和版权并遵守同样条款；限制将模型或衍生品用于改进不在例外范围的商业 AI 模型。固定协议中中文年收入门槛为 **1 亿元人民币**、月活跃用户门槛为 **1 亿**，达到条款中的条件时须另行获得许可。英文版收入数额不一致；其第 9 条规定中文优先。不能把这些素材标为“无限制商用”。[固定中文协议来源](https://github.com/index-tts/index-tts/blob/ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c/LICENSE_ZH.txt)

衍生品声明：**该衍生品对原模型所作的任何改动与原模型原始权利人无关，原始权利人对该衍生品不背书、不担保、不承担责任。** 完整英文声明见 `NOTICE`。

这些记录验证文件来源和技术完整性，不代表已由真人逐段验收，也不提供声音人格权或任意第三方内容的额外授权。用户导入和克隆的声音由用户自行取得必要授权；这些私人数据不随本公开包分发。

## 可选下载的模型与运行组件

| 组件 | 固定来源 | 许可 |
| --- | --- | --- |
| Qwen3-TTS CustomVoice 0.6B | 上表固定 revision | Apache-2.0 |
| Qwen3-TTS Base 0.6B | `5d83992436eae1d760afd27aff78a71d676296fc`；[官方模型](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base/tree/5d83992436eae1d760afd27aff78a71d676296fc) | Apache-2.0 |
| qwen-tts | 0.1.1；[官方项目](https://github.com/QwenLM/Qwen3-TTS) | [Apache-2.0 全文](licenses/Qwen-Apache-2.0.txt) |
| IndexTTS 源码 | `ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c`；[官方源码](https://github.com/index-tts/index-tts/tree/ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c) | 主协议 `LicenseRef-Bilibili-IndexTTS`，**源码也不是 MIT**。其中内嵌第三方代码另有许可，不能以主协议替代。此发行不镜像整棵 IndexTTS 源码。 |
| IndexTTS 2.5 模型 | `c39ce5ba981572cb187443877ff559dfb246ce63`；[官方模型](https://huggingface.co/IndexTeam/IndexTTS-2.5/tree/c39ce5ba981572cb187443877ff559dfb246ce63) | bilibili Model Use License Agreement |
| w2v-bert-2.0 | `da985ba0987f70aaeb84a80f2851cfac8c697a7b`；[官方模型卡](https://huggingface.co/facebook/w2v-bert-2.0) | MIT；保留下载目录原 README/许可 |
| CAMPPlus | `e4b6ede7ce16997aff4ae69fbca1f0175e2afede`；[官方模型卡](https://huggingface.co/funasr/campplus) | Apache-2.0；保留下载目录原 README/许可 |
| BigVGAN v2 22kHz | `633ff708ed5b74903e86ff1298cf4a98e921c513`；[官方模型卡](https://huggingface.co/nvidia/bigvgan_v2_22khz_80band_256x) | MIT；保留 NVIDIA 版权和下载目录原 LICENSE |

Python、PyTorch/CUDA 组件及其 Python 依赖由安装流程直接取得；它们各有独立许可和随包第三方声明，不属于根 MIT 的统一授权。保留安装结果中的 `LICENSE`、`COPYING`、`NOTICE`、`ThirdPartyNotices` 等文件，不从既有虚拟环境拷贝二进制作为本项目整包分发。

## FFmpeg

小型应用包不含 FFmpeg 可执行文件。安装器从 gyan.dev 下载固定版本到项目自己的 `runtime/ffmpeg`，保留该压缩包的许可、说明和来源，不替换系统上的 FFmpeg。FFmpeg 官方只提供源码，Windows 二进制可来自其[下载页列出的 gyan.dev 或 BtbN](https://ffmpeg.org/download.html)；不能称这些二进制为 FFmpeg 官方签名构建。

FFmpeg 主体通常为 LGPL-2.1-or-later，开启 GPL 组件会改变实际构建许可；例如 gyan 的 GPL 构建不能标成 MIT/LGPL。安装器应固定具体构建、验证 SHA256、记录版本/下载地址，并保留来源说明。[FFmpeg 许可说明](https://ffmpeg.org/legal.html)

如果将来把 FFmpeg 或完整 Python/CUDA 环境直接装入我方 Release ZIP，应重新按实际二进制及链接方式处理对应源码、许可和再分发要求，不能沿用“本包不含”的前提。
