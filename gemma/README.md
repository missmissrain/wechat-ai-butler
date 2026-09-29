# Gemma 4 E4B 下载与校验

| 项目 | 值 |
|---|---|
| Hugging Face | https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF |
| 国内镜像 | https://hf-mirror.com/unsloth/gemma-4-E4B-it-GGUF |
| 权重 | `gemma-4-E4B-it-Q4_K_M.gguf` — 4 977 171 584 字节 |
| 视觉投影器 | `mmproj-BF16.gguf` — 991 552 320 字节 |

## 用法

```powershell
# 需要 curl.exe（Windows 10/11 自带），8 线程、64MB 分片
python downloadGemmaModel.py
```

脚本行为：

1. 从镜像按 HTTP Range **分块并行下载**（断点续传：分片大小对就直接复用缓存）；
2. 分片长度校验 → 顺序合并 → 全文件 **SHA-256**；
3. 控制台输出 `[dqtm] 已下载 / 总字节` 进度；
4. 落地 `下载校验.json`（本目录已带一份，size 与 sha256 可对照）。

下载后目录：

```
model/
  gemma-4-E4B-it-Q4_K_M.gguf
  mmproj-BF16.gguf
```

启动参数、显存要求与接进 Harness 的方法见 `../docs/本地模型与Gemma.md`。
