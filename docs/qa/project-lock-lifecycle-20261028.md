# 项目锁的生命周期：判死 / 心跳 / 接管 / 启动清理（任务 60）

> 2026-10-28。用户删项目被"另一台电脑 `MacBook-Air-2.local`"挡住——那台电脑就是本机
> 改了名（现在是 `MacBook-Air-3.local`），库里 11 个项目的锁全是应用被强杀 / 重启后
> 留下的死锁（PID 早已不存在）。全部验收在**临时库副本**上做，真书库没碰。

## 三个根因 → 三处修

| 根因 | 旧行为 | 现在 |
|---|---|---|
| 锁没有生命周期 | 文件在就算占用，永远不判死 | 持锁期间每 60 s 写 `heartbeat_at`；跨机 10 分钟没心跳判过期 |
| 主机名变了认不出自己 | 只比主机名，`-2` → `-3` 就成了"别人" | 锁里写**机器指纹**（macOS `IOPlatformUUID` / Windows `MachineGuid` / Linux `machine-id` 的哈希）；老锁没有指纹时退回"主机名前缀 + 本机进程是否存活" |
| 判定只看文件存在 | 不看持有者死没死 | 同机 + PID 不存在 → 过期（直接接管）；跨机 → 看心跳 |

判定表（`core/project/lock.py` 开头，代码与本文同一份口径）：

| 情况 | 判据 | 结果 | 要不要问用户 |
|---|---|---|---|
| 没有锁 / 锁文件损坏 | — | `free` | 不问（损坏文件启动时清掉） |
| 同机 + 进程活着 | 机器指纹或主机名相同，`kill -0` 成功 | `held` | 拒绝，给「只读打开 / 强制打开」 |
| 同机 + 进程不在 | 同上，`kill -0` 失败 | `expired_same_machine` | **不问**，直接接管 |
| 本机旧主机名 + 进程不在 | 前缀相同（`MacBook-Air-2` → `MacBook-Air-3`），老锁无指纹 | 同上，标记 `previous_hostname` | **不问**，直接接管并说明"本机以前的名字" |
| 另一台电脑 + 10 分钟内有心跳 | 指纹/主机名都不同 | `held` | 拒绝 |
| 另一台电脑 + 心跳已停 | 同上，`heartbeat_at` 超过 10 分钟 | `expired_other_machine` | **问一次**（网盘可能只是没同步） |

`heartbeat_at` 是跨机判死的**唯一**依据，优先于文件 mtime：网盘同步会把 mtime 刷成
"现在"，但改不了心跳字段。老锁没有这个字段才退回 `acquired_at` / mtime。

## 接口与界面

- `DELETE /api/projects/{id}?confirm=true`：锁过期 → **409 `project_lock_expired`**，
  `error.data.lock` 带 `hostname / host_note / pid / process_alive / last_seen_at /
  age_seconds / age_text / expired / can_take_over`；`&force=true` 才真的接管。
  真占用 → 409 `project_busy`，**force 也不放行**。
- `POST /api/projects/{id}/open`：跨机过期 → 400 `project_lock_expired`（带同一份
  `data.lock`）；`force=true` 打开后 warning 写"已强制接管一把过期的锁：…"。
- 界面：项目卡上过期锁显示「锁已过期」+「接管并打开」；删除 / 打开被挡时弹一个
  确认框，写清 **项目 / 来源（本机 / 本机以前的名字 / 另一台电脑）/ 时间（多久以前）/
  状态（进程不存在 → 已过期；进程还在写）**，过期才出现「强制删除」。
- 顺手修的一处：打开项目的提示（强制接管 / 覆盖死锁 / 任务被中断）原来会被紧跟的
  `loadLibrary()` 清掉（它开头就把提示条 `hidden = true`），现在等列表刷完再显示。

## 实测（macOS，临时库副本，真书库未动）

用 4 个真项目副本（`b2t_YTA7R0` / `b2t_WVM18R` / `b2t_C0WS5D` / `b2t_NSTE6Z`）造锁：

| # | 造的锁 | 结果 |
|---|---|---|
| 1 | 本机 `MacBook-Air-3.local` + pid 123457（不存在），3 天前 | 打开 **200**，warning「覆盖了一把过期的锁：锁已过期：本机，进程 123457 已经不存在（10-25 08:21，3 天前），可以直接接管」 |
| 2 | 同上，5 天前，直接删（没打开过） | **200**（过期锁不再 409） |
| 3 | `MacBook-Air-2.local` + pid 72172（不存在），9 天前（**用户现场**） | 卡片无"使用中"；打开 **200**，warning 写明「这把锁来自本机以前的主机名 MacBook-Air-2.local，进程 72172 已经不存在」 |
| 4 | `Old-PC.local` + 12 天前心跳 | 卡片 `lock_held=true, lock_expired=true`；打开 **400 `project_lock_expired`**；删除 **409 `project_lock_expired`**（`age_text="12 天前"`、`can_take_over=true`）；`&force=true` → **200** |
| 5 | 本机 + 真活进程（`sleep 900` 的 pid） | 打开 **400 `project_busy`**；删除 **409**；`&force=true` 仍 **409**；锁文件原样 |
| 6 | 应用启动时库里有本机死锁 | 启动日志「已清理 1 把本机残留的锁（进程已退出）：b2t_YTA7R0」，文件已删 |
| 7 | 打开项目后 `kill -TERM` 服务 | 优雅关闭后 `.lock` 已删除（`atexit` + `finally` 双保险） |
| 8 | 心跳（把间隔改 0.3 s 的单测） | `heartbeat_at` 00:22:16 → 00:22:18 确实在刷新；释放后不再刷新 |

截图（真浏览器 headless Chrome 156 + CDP，1280×900）：

- `docs/screenshots/lock-expired-dialog.png` — 过期锁的删除确认框（来源 / 时间 / 状态 +
  「取消」「强制删除」）
- `docs/screenshots/lock-busy-dialog.png` — 真占用的确认框（**没有**强制按钮）
- `docs/screenshots/lock-card-expired.png` — 卡片上的「锁已过期」徽标与「接管并打开」
- `docs/screenshots/lock-open-dialog.png` — 打开被挡时的同一套说明 +「强制打开」
- `docs/screenshots/lock-takeover-opened.png` — 接管后进入页面视图，顶部提示条写明"已强制接管"

## 测试

- 新增 `tests/unit/test_lock_lifecycle.py`（17 条）：同机死/活、本机旧主机名、
  跨机新/旧心跳、`heartbeat_at` 优先于 mtime、心跳刷新、`release` 拒绝删别人的活锁、
  `release_all`、启动清理（死锁 + 损坏 + 不动别的电脑）。活进程用
  `sys.executable -c "time.sleep(30)"`（跨平台，不依赖 `sleep`）。
- 新增 `tests/integration/test_lock_delete_api.py`（7 条）：同机死锁不挡删除、
  打开自动接管、旧主机名不挡删除、跨机过期要确认（含 `data.lock` 字段）、
  跨机过期打开报 400、**活锁 force 也不放行**、项目列表标记 `lock_expired`。
- `tests/integration/test_ui_assets.py` 加一条接线测试：确认框节点 / `error.data.lock` /
  `force=true` / 卡片徽标文案。
- `.venv/bin/python -m pytest -q` → **953 passed, 1 warning**（119.6 s）。

## 没验的

1. **Windows 未验证。** 机器指纹走 `winreg MachineGuid`、进程存活走 `os.kill(pid, 0)`，
   两条都按跨平台写，但只在 macOS 跑过。`SIGBREAK` 的退出处理同样没在 Windows 上跑。
2. **两台真机同名/改名没实测。** "本机旧主机名"靠前缀比较 + 本机 PID，若另一台真机的
   主机名前缀相同、且它的 PID 恰好在本机也存在，会被判为"占用"（保守方向，不误删）。
   有机器指纹的新锁没有这个问题。
3. **网盘同步延迟没实测。** 心跳阈值 10 分钟是说明书建议值；只在本地造数据验过。
4. **没有验证 Windows 上 `atexit` 在窗口关闭（点 ✕）时是否一定触发**——macOS 上是
   终端信号（SIGTERM/SIGHUP）路径，Windows 打包版的关窗行为属于未验证项。
