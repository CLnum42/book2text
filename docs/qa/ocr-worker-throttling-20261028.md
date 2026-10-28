# 识别期间界面不卡：限线程 + 降优先级 + 忙时复用派生缓存（任务 68）

> 2026-10-28。被测：《安乐哲 译本处理.PDF》→ `b2t_ZAQHGH`（662 页纯英文，US Letter）。
> 所有数字本机实测（MacBook-Air-3，10 逻辑核，Apple Silicon）。识别在独立副本库上跑，
> 真书库没碰。

## 一、问题的机制

识别本来就跑在子进程里（`python -m book2text.worker`），但**没有任何线程数 / 优先级控制**：

- 适配器构造 RapidOCR 时只传了 `Global.log_level`，`EngineConfig.onnxruntime.intra_op_num_threads` 是 **-1**（= 所有核）
- spawn 子进程时没有设 `OMP_NUM_THREADS` 之类，numpy / OpenBLAS 各开一份
- 没有 `nice` / `SetPriorityClass`

结果：识别开始后 onnxruntime 把 10 个核吃满，界面请求只能等。

实测（识别中 vs 空闲，同一组请求）：

| 请求 | 空闲 | 识别中（改前） |
|---|---:|---:|
| `GET /projects/{id}` | 36 ms | 111 ms |
| `/review/finish-summary` | 5 ms | **357 ms** |
| `/review/marks?page=35` | 5 ms | 38 ms |
| `/review/tree` | 18 ms | 59 ms |
| `/pages/35/blocks` | 19 ms | 24 ms |
| 页图 `size=zoom` | 126 ms | **260 ms** |
| 页图 `size=thumb` | 20 ms | 130 ms |
| 界面：切页面视图 / 回审校 / 翻页 / 下一处 | 48 / 67 / 67 / 67 ms | 40 / 82 / 84 / 66 ms |

## 二、改了什么

1. **限线程**：新模块 `core/limits.py`，`worker_thread_count() = max(1, cpu_count - 2)`
   （这台 10 核 → **8**）。
   - ONNX Runtime 认 `EngineConfig.onnxruntime.intra_op_num_threads = 8`、
     `inter_op_num_threads = 1`（经 RapidOCR 的 params 传进去）；
   - BLAS 只认环境变量：spawn 之前设 `OMP_NUM_THREADS` / `OPENBLAS_NUM_THREADS` /
     `MKL_NUM_THREADS` / `NUMEXPR_NUM_THREADS` / `VECLIB_MAXIMUM_THREADS`，子进程继承。
2. **降优先级**：spawn 时 `preexec_fn=os.nice(10)`（Windows 用
   `BELOW_NORMAL_PRIORITY_CLASS` 创建标志）；worker 自己启动时再 `os.nice(10)` 兜一层
   （覆盖"不是从执行者启动"的情况）。实测子进程 `NI = 19`。
3. **忙时复用派生缓存**（新模块 `core/project/cache_policy.py`）：识别**每认完一页都写库**，
   签名每 3–5 秒变一次，四个派生缓存于是永远命不中。规则：**只有本项目确实有任务在跑、
   且缓存不超过 10 秒**时才复用旧结果；任务一结束签名稳定，立刻回到实时。
   用到的地方：收尾面板、阅读流 marks、阅读流 segments。
4. **界面提示**：任务抽屉里，任务在跑时多一行
   「识别进行中，界面可能变慢一点（已经给界面留了核，不会卡死）」。

## 三、结果

### 识别本身没有变慢

同一本书、同一批页（`ocr_run` 的 `created_at → finished_at`）：

| | 页数 | 均 | 中位 | 最大 |
|---|---:|---:|---:|---:|
| 限线程前 | 59 | 4.24 s | 4.00 s | 11.0 s |
| 限线程后 | 57 | **3.51 s** | **3.00 s** | 13.0 s |

不但没慢，中位还低了 1 秒（同一时段机器负载也更轻，所以只能下"没有变慢"的结论，
不能说"限线程变快了"）。

### 识别中的界面延迟（改后）

| 请求 | 空闲 | 识别中 | 判据 ≤300 ms |
|---|---:|---:|:--:|
| `GET /projects/{id}` | 36 ms | 74 ms | ✅ |
| `/review/marks?page=35` | 5 ms | **14–30 ms** | ✅ |
| `/review/tree` | 18 ms | 25 ms | ✅ |
| `/pages/35/blocks` | 19 ms | 86 ms | ✅ |
| 页图 `size=zoom` | 126 ms | 251 ms | ✅ |
| 页图 `size=thumb` | 20 ms | 41–109 ms | ✅ |
| `/review/finish-summary`（稳态） | 5 ms | **19–23 ms** | ✅ |
| 界面：切视图 / 翻页 / 下一处 | 48–67 ms | 48–67 ms | ✅ |

**一个例外，说明清楚**：`finish-summary` 在识别中有毛刺 ——
连打 6 次实测 `590 / 90 / 120 / 130 / 100 / 610 ms`，另有一次在**刚重启的进程 + 缓存被
一页 OCR 作废**时到 **3,483 ms**。原因是它要重算 662 页（空闲时因为有缓存，同样条件
冷算 340 ms、热 10 ms）。这是"整本重算"的老问题，不是识别抢 CPU 造成的，
要根治得把收尾面板做成增量；不在这一刀里。

## 四、重跑的可复现命令

```
# 识别中
curl -s -H "X-B2T-Token: e1" http://127.0.0.1:8856/api/projects/<id>/jobs     # 看进度
python /tmp/v67_busy.py "识别中"      # 同一组请求 + 同一组界面操作
# 空闲基线：先 POST /jobs/{id}/pause，再跑同一个脚本
```

`B2T_TIME_REQUESTS=1` 启动服务时，每个 `/api` 请求的服务端耗时也会打进标准输出
（排查用，默认关闭）。

## 五、测试

`pytest -q` → **976 passed, 1 warning**（识别同时在跑，整套 296 s；空闲时 140 s —— 这本身就是抢 CPU 的证据）。
