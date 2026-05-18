# AgentBridge Troubleshooting

Practical recovery guide for issues you hit running AgentBridge in the wild.
Organized by symptom — search the symptom text, follow the diagnosis +
recovery steps. If you can't find your symptom here, file an issue with
the daemon log (`~/Library/Application Support/AgentBridge/agentbridge.log`
on macOS).

---

## `abg codex` hangs at "Launching detached daemon on control port 4502"

### Symptom
```
[agentbridge] Ensuring daemon is running...
[agentbridge] Launching detached daemon on control port 4502
... (no further output, terminal appears stuck)
```

### Cause
Daemon spawned but crashed during startup before becoming `/readyz`-able.
Common reasons:
- Control port 4502 already in use by an unrelated process
- State dir corruption (e.g. left over from forced kill)
- Missing `codex` CLI in PATH (daemon's codex app-server spawn fails)
- `bun` binary not at expected path

Older versions silently waited 10s before timing out. PR-#?? (commit
`f8c82a9`) added race-against-exit diagnostics: if the daemon dies during
startup, the CLI surfaces the exit code + log file path in milliseconds.

### Recovery
1. If on the fixed version, the error will name the cause directly. Follow
   the hint (check log, free port, etc.).
2. On older version, manually check:
   ```bash
   # Is something else on 4502?
   lsof -nP -iTCP:4502 -sTCP:LISTEN
   # Daemon's last log entries
   tail -30 ~/Library/Application\ Support/AgentBridge/agentbridge.log
   # Codex CLI in PATH?
   which codex
   ```
3. Stuck lock file: usually self-cleans on next start (CLI checks if
   lock-holder pid is alive). If not:
   ```bash
   rm ~/Library/Application\ Support/AgentBridge/daemon.lock
   ```
4. As a workaround, spawn daemon manually with env set:
   ```bash
   AGENTBRIDGE_CONTROL_PORT=4502 \
   AGENTBRIDGE_CODEX_SANDBOX=workspace-write \
     bun run path/to/plugins/agentbridge/server/daemon.js > /tmp/abg.log 2>&1 &
   ```
   Then `abg codex --via-proxy` sees daemon healthy + attaches without
   re-spawning.

---

## `--sandbox=workspace-write` doesn't take effect — Codex still read-only

### Symptom
```
$ abg codex --via-proxy --sandbox workspace-write
[agentbridge] Warning: --sandbox=workspace-write ignored — daemon is already running.
[agentbridge]   The codex app-server sandbox was fixed at daemon spawn time.
[agentbridge]   To switch sandboxes: `abg kill && abg codex --sandbox=workspace-write`
```
or worse, no warning but Codex still can't write files.

### Cause
Sandbox flag is captured at **daemon spawn time** and propagated to the
codex app-server child via env var. If daemon was started earlier without
`--sandbox`, the env wasn't set, so codex inherits read-only default. The
warning is correct: CLI runs in your terminal but the daemon is a separate
detached process — your `--sandbox` only affects the daemon's env if you're
the CLI that spawned it.

### Recovery
```bash
abg kill                                                # 干净停掉
cd /path/to/your/project                                # 重要 — daemon 跟 cwd
abg codex --via-proxy --sandbox workspace-write         # 新 daemon 带 env spawn
```

Verify:
```bash
grep "Spawning codex" ~/Library/Application\ Support/AgentBridge/agentbridge.log | tail -1
```
应该看到 `... (sandbox=workspace-write)` 后缀。

---

## Codex TUI 跑在错的 cwd

### Symptom
TUI 启动后顶部框显示：
```
directory: ~/wrong/path
```
不是你 `cd` 进的目录。

### Cause
Codex app-server 的 cwd 是 **daemon spawn 它的时候** daemon 进程当下的
cwd。daemon 是别的终端早先启的，那时的 cwd 不同。新跑 `abg codex` 只是
启动 TUI 连到现有 daemon 的 app-server，cwd 跟 app-server 走不跟 TUI 走。

### Recovery
同上一节：`abg kill && cd <对的目录> && abg codex --via-proxy ...`

---

## "Shared Codex TUI is busy with another turn. Retry."

### When it's correct
Codex 正在跑一个 turn（你能从 TUI 窗口里看到 reasoning/code generation
等输出）。等它结束再 reply。bridge 显示 `⏳ Codex is working...` push
notification 时也是这种情况。

### When it's a bug
若 Codex TUI 看起来 idle 没在跑、但 reply 一直被拒说 busy/no thread，
可能是：

1. **multi-pair 注入到错的 pair**：fixed in PR #81 commit `ebea1d3`。
   旧 daemon bundle 上 paired-Claude reply 走 default pair 的 adapter
   即使 chat homed on 别的 pair。升级到 patch 后的 bundle。

2. **TUI 没真 attached**：检查 healthz：
   ```bash
   curl -s http://127.0.0.1:4502/healthz | python3 -m json.tool | grep -i tui
   ```
   `tuiConnected: false` 表示 codex TUI 没接到 daemon。重启 TUI。

3. **Pair tear-down race**：fixed in `ef08de2`。Claude 早些 paired，然后
   pair 被 destroy/teardown，但 chat state 不知道。Reply 命中错误路径。
   重启 Claude Code (`/resume` 或新 conversation)。

---

## `abg kill` 后 bridge 不自动连回

### Symptom
跑了 `abg kill` 然后重启 daemon，但你那个 Claude Code session 的 bridge
还显示 disabled state，不会自动连。

### Cause
**这是 intentional 行为**。`abg kill` 写一个 `killed` sentinel 文件，
bridge 看到这个 sentinel 拒绝自动重连——避免你想停 daemon 但 bridge 不
死心反复拉。

### Recovery
- 在 Claude Code 里跑 `/resume`，bridge 会清掉 disabled state 重连
- 或者：开新 conversation
- 或者：重启 Claude Code

最稳：重启 Claude Code，新 process 没有任何 stale 状态。

---

## "Daemon was intentionally killed by user (killed sentinel found) — not reconnecting"

### 同上一节
这是 bridge 看到 killed sentinel 时的标准日志，**不是错误**。按上面的
recovery 走。

---

## Multi-pair: `abg codex --pair work --via-proxy` 失败 PAIR_PORTS_BUSY

### Symptom
```
PAIR_PORTS_BUSY: pair "work" ports (appPort=ws://127.0.0.1:4510...) are held by another process
conflictPort: 4510
conflictPid: <some pid>
```

### Cause
work pair 之前 ensure 过 (registry 记着用 4510)，但被外部进程占用了。
常见：之前 daemon 崩了留下 orphan codex 进程仍在监听。

### Recovery
1. 杀 orphan:
   ```bash
   kill <conflictPid>
   ```
2. 或者重新分配 work 的 port:
   ```bash
   abg pairs rm work --forget        # 清掉 registry 让下次 ensure 重新分配
   abg codex --pair work --via-proxy # 重新 ensure，分配新 port
   ```

---

## Daemon EPIPE 死循环 (`agentbridge.log` 暴涨到 GB 级)

### Symptom
日志文件几小时内涨到几个 GB；磁盘暴用。

### Cause
**已修**（commit `e0c73ca`）。旧 daemon 在 stdout/stderr broken pipe 时
uncaughtException handler 写 log 又触发 EPIPE → handler 又被调 → 无限
循环。典型触发：`bun daemon.js | head` 之类。

### Recovery
- 升到 patched daemon bundle (PR #81 内)
- 已发生：truncate log + 不要再用 piped output 跑 daemon
  ```bash
  echo "" > ~/Library/Application\ Support/AgentBridge/agentbridge.log
  ```

---

## "Codex thread is still provisioning. Wait for system_thread_ready."

### When it's correct
新 Claude attach 时 bridge 还在 bootstrap 它的 dedicated Codex thread。
几秒内会收到 `system_thread_ready` 推送，之后 reply 就能发。

### When it's a bug
若一直拿不到 `system_thread_ready`，daemon side 的 bootstrap 失败了。
**已修**（commit `18f60d8`）：bootstrap 失败时 daemon 自动 reap chat →
bridge 自动重连 → fresh bootstrap。

旧 bundle 上要手动重启 Claude Code 才能恢复。升级 bundle 推荐。

---

## "Shared Codex TUI is no longer connected. Wait for transition to isolated mode."

### When it's correct
你的 pair 的 codex TUI 真的断了（用户关了 TUI 窗口），daemon 在做
transitionToIsolated 让 Claude 转去 default pair 的 isolated thread。

### When it's a bug
multi-pair 场景下，你 paired with `work` pair，work 的 TUI 完好，但
看到这条文案。**已修**（commit `58f01fd`）：旧代码错误地读 default 的
`proxyTuiSlot`（为 null）来生成文案，新代码读 home pair 的。升级 bundle。

---

## `abg pairs ls` 显示某 pair `LIVE ○`（not live）但你刚启了它

### Cause
Daemon 启动期 race：你 `abg codex --pair X` spawn 了 daemon 同时
ensure_pair("X") 但 daemon 还没完成对应 codex app-server 的 spawn。
sleep 1-2s 再 `abg pairs ls` 一般就 live 了。

如果持续 not live：
1. 看日志 `grep "pair=X" ~/Library/Application\ Support/AgentBridge/agentbridge.log`
2. 多半是端口被占（见 PAIR_PORTS_BUSY 章节）

---

## `abg kill` 担心影响其他正在跑的项目

### 影响范围（macOS / Linux）

✅ **会动**：
- 一个 AgentBridge daemon (每台机器只有一个)
- daemon 启动的 codex app-server 子进程
- daemon pid 文件追踪到的 codex TUI 进程
- 所有 attached Claude Code session 的 bridge（进 disabled state，但
  Claude Code 进程本身不死）

❌ **不会动**：
- 任何独立的 Codex CLI / Codex.app 桌面应用
- 任何不通过 `abg` 启动的 codex 进程
- 你的 Python / Node / 其他脚本
- 文件 / 数据库 / 其他基础设施

### 验证清单
跑 `abg kill` 前看一眼受影响范围：
```bash
curl -s http://127.0.0.1:4502/healthz | python3 -m json.tool | grep attachedClaudeCount
```
显示有几个 Claude Code 会被 disable 它们的 bridge。若只有 1 = 你这一个，
没旁路影响。

---

## 真的卡死无法恢复 (nuclear option)

```bash
# 1. 杀 daemon + 任何 abg 子进程
abg kill
pgrep -fl "agentbridge|abg" | grep -v grep | awk '{print $1}' | xargs kill -9 2>/dev/null

# 2. 清状态目录
rm -rf ~/Library/Application\ Support/AgentBridge/{daemon.pid,daemon.lock,status.json,killed,startup.lock,pairs}

# 3. 注：保留 agentbridge.log 用于事后看；不重要则也清掉
# rm ~/Library/Application\ Support/AgentBridge/agentbridge.log

# 4. 重启
abg codex --via-proxy --sandbox workspace-write
```

⚠️ 第 2 步**只清 daemon 内部状态**，不删你的 config (`.agentbridge/config.json`
在项目内) 或 CLAUDE.md / AGENTS.md 之类的 collab 内容。

---

## 收集诊断信息（提 issue 前）

```bash
echo "=== Versions ==="
abg --version
bun --version
claude --version 2>&1 | head -1
codex --version

echo ""
echo "=== Daemon health ==="
curl -s http://127.0.0.1:4502/healthz 2>&1 | python3 -m json.tool 2>&1 | head -30

echo ""
echo "=== Daemon log tail ==="
tail -50 ~/Library/Application\ Support/AgentBridge/agentbridge.log

echo ""
echo "=== State dir contents ==="
ls -la ~/Library/Application\ Support/AgentBridge/

echo ""
echo "=== Processes ==="
pgrep -fl "agentbridge|daemon\.js|codex app-server" | grep -v grep
```

把这一坨贴 issue 里。

---

## 参考

- 主架构：`docs/shared-thread-mode-v2.3-spec.md`
- 全局清理 audit：`docs/multi-pair-globals-audit.md`
- 已修 lifecycle issue：#82 / #83 / #84
- Probe coverage：`probes/multi-pair/` (M01-M11 + audit-d1/d3)
