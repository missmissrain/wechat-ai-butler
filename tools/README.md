# tools/ · 维护脚本

这些脚本**原先散落在系统临时目录**（`%TEMP%\opencode\`），被项目里的代码引用着——
等于项目依赖了随时可能被清理、且写满本机绝对路径的外部文件。现在收进项目内并脱敏：

- 不写死任何本机绝对路径（`C:\Users\<某人>`、`D:\py39`、`G:\...`）
- 用 `Path(__file__)`、`Path.home()`、环境变量推导位置
- 不含密钥、token、聊天内容

## 脚本清单

| 脚本 | 用途 |
|---|---|
| `stop_stack.py` | 停止欣爱（harness）进程；被 `switch_model.py` 与控制台复用 |
| `inject.py` | 向本机调试注入口（默认 3081）发消息，免真手机联调 |
| `check_state.py` | 只读查看：发送队列、投递、租约、时间线/图谱规模 |
| `trace_pipeline.py` | 追踪一条消息的完整链路（哪一步卡住一眼可见） |
| `reset_weixin_state.py` | 清调试数据（**默认不动长期记忆**，要清加 `--purge-memory`） |
| `bench_memory.py` | 时间线写入性能基准（防写入变慢拖住主链路） |
| `make_backup.py` | 参数化版本备份（替代历史上散落的一串 `make_backup_vNN.py`） |
| `autostart.py` | **开机自启入口**：等网络/代理就绪后拉起 harness（见下） |
| `install-autostart.ps1` | 注册/注销/查看自启快捷方式（`-Remove` / `-Status`） |

## 开机自启（欣爱后端）

启动文件夹里的 `欣爱（微信后端）.lnk` → `pythonw tools\autostart.py`。**不需要管理员权限**
（用启动文件夹而不是计划任务，和控制台自启 `Agent 控制台.lnk` 同一套做法）。

`autostart.py` 解决三件事，所以别直接把 `start_stack.py` 丢进启动文件夹：

1. **延迟启动**：开机时网络/代理（Clash 127.0.0.1:7897）常常还没起，启动器的代理探测与微信
   token 探活会得到错误结论。默认等 45 秒（`--delay` 可改）。
2. **没有黑框**：`pythonw` 下没有控制台，`print` 无处可去；脚本把 stdout/stderr 接到
   `runtime/autostart.log`，出问题能查。
3. **幂等**：端口已在监听就什么都不做（手动启动过、或控制台拉起过，都不会重复拉一套）。

```powershell
# 注册 / 注销 / 查看
powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1
powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Remove
powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Status

# 自启入口自身
python tools\autostart.py --check          # 只体检，不启动
pythonw tools\autostart.py --delay 90      # 手动按自启方式拉起
```

## 用法示例

```bash
python tools/check_state.py                 # 先看链路是否健康
python tools/inject.py "帮我查一下房租"      # 注入一条测试消息
python tools/trace_pipeline.py              # 追踪最近一条消息
python tools/bench_memory.py                # 写入性能回归
python tools/make_backup.py v3.6 "说明"     # 备份
```

## 没有收回来的东西

系统临时目录里还有约 200 个**一次性探针与数据转储**（`session_dump.txt`、`*_probe.jsonl`、
各类 `dump_*` / `probe_*` 实验脚本）。它们**故意不收进项目**，原因有二：

1. 多数含**聊天原文、会话导出、token 片段**——收进项目等于把隐私搬进仓库；
2. 它们是针对当时那个问题的一次性实验，没有复用价值。

需要时留在临时目录即可；项目运行不依赖它们。
