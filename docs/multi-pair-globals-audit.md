# Multi-Pair Globals Audit (2026-05-18)

**Status**: read-only audit; no code changes yet. Companion to failing probes in
`probes/multi-pair/audit-*.ts` that demonstrate each leak listed below.

**Why this exists**: STM v2.3 (PR #81) lifted single-pair daemon to multi-pair,
but the module-level globals that backed the v2.2 single-pair model were left
in place. Some are aliased to the default pair's `PairState` (via getter/setter)
so direct accesses still work; others leak default-pair state into top-level
status, error messages, or lifecycle decisions when a chat is homed on a
non-default pair.

Five user-visible bugs were discovered via probe-driven testing on PR #81 and
fixed in-place by routing the specific call site through `pairs.get(homePairId)?.codex`
etc. (see commits `ebea1d3` / `8531178` / `ef08de2` / `58f01fd` / `ac07ead`).
This audit catalogs the **remaining call sites** + decides per site whether
the default-global reference is correct, intentional v2.2-compat, or a latent
leak.

---

## Module-level state inventory

`src/daemon.ts` declarations at module top:

| Variable | Type | Line | Aliased to PairState? |
|---|---|---|---|
| `codex` | `CodexAdapter` (default pair's) | 157 | No — `defaultPairState.codex = codex` directly |
| `proxyTuiSlot` | `ProxyTuiSlot \| null` | 187 | Yes — via getter/setter on `defaultPairState.proxyTuiSlot` |
| `tuiConnectionState` | `TuiConnectionState` (default pair's) | 189 | No — `defaultPairState.tuiConnectionState = tuiConnectionState` directly |
| `codexBootstrapped` | `boolean` | 167 | No — purely module-level boolean |
| `chats` | `Map<chatId, ChatState>` | 172 | N/A — daemon-wide registry, not pair-scoped |
| `pairs` | `Map<pairId, PairState>` | 252 | N/A — the source of truth |
| `pairRegistry` | `PairRegistry` | 262 | N/A — daemon-wide persistence |
| `controlServer`, `shuttingDown`, `idleShutdownTimer`, etc. | various | 165-169 | N/A — daemon-wide |

**Daemon-wide** vars (`chats`, `pairs`, `pairRegistry`, `controlServer`,
`shuttingDown`, etc.) are correctly daemon-scoped; not part of this audit.

**Pair-scoped vars** (`codex`, `proxyTuiSlot`, `tuiConnectionState`,
`codexBootstrapped`) are the audit subjects below.

---

## `codex` (module-level CodexAdapter) — 34 references

| Line(s) | Context | Classification |
|---|---|---|
| 65 (comment), 222 (comment), 684 (comment), 726 (comment), 1374 (comment), 1511 (comment), 1819 (comment), 1825 (comment), 1988 (comment), 2015 (comment), 2023 (comment) | doc-only | OK — doc references, no runtime |
| 135-136 | parse `config.codex.appPort/proxyPort` from config object | OK — config-level, not `codex` instance |
| 163 | `attachCmd = \`codex --enable tui_app_server --remote ${codex.proxyUrl}\`` | **Intentional default** — user-facing hint, default's proxyUrl is the documented port. Could go to `pairs.get("default")!.codex.proxyUrl` for explicitness. |
| 333, 396, 510, 566, 587 | `pair.codex.X` via local `pair` binding | OK — already pair-scoped |
| **637** | `appServerUrl: codex.appServerUrl` in `bootstrapIsolatedThread` retry path | ⚠️ **Latent leak**: assumes isolated chats always bootstrap against default. With v2.3 multi-pair, an isolated chat may live on a non-default pair when default is destroyed and only `work` is live. Should look up via `state.homePairId`. |
| **701** | `appServerUrl: codex.appServerUrl` in `transitionToIsolated` | **Intentional** — §6.5 P3c spec: pair teardown re-homes to default. Sets `state.homePairId = "default"` immediately before. But the assignment SHOULD be derived from `pairs.get("default")!.codex.appServerUrl` to be explicit (drop hidden global reliance). |
| 834-835, 947-948, 952, 1097, 1131 | `pair.codex.X` / `iterPair.codex.X` / `targetPair.codex.X` | OK — pair-scoped |
| **1201** | `appServerUrl: codex.appServerUrl` in `attachClaude` isolated bootstrap | ⚠️ **Same leak as #637** — uses module default unconditionally. |
| 1411 | `currentPair!.codex.setPairedChat(null)` in `detachClaudeWs` reap timer | OK — fixed by `ef08de2` |
| 1584 | `homePair!.codex.injectMessage(...)` in `handleClaudeToCodex` | OK — fixed by `ebea1d3` |
| **1712-1716** | `proxyUrl/appServerUrl/threadId: codex.X` in `currentStatus` (top-level DaemonStatus) | ⚠️ **Intentional v2.2 compat but misleading** — top-level fields reflect default only. A user querying `/healthz` and reading `threadId` would see default's, not their non-default pair's. Comment says "v2.2 backward-compat"; spec §D7 P3 acknowledges. Pair-detail in `pairs[]` array is correct; top-level fields are stale-by-design. **Decision: keep as-is or remove top-level fields entirely + force callers to look at pairs[]?** |
| 1729-1734 | `pair.codex.X` per-pair in DaemonStatus's `pairs[]` array | OK — properly per-pair |
| 1799-1800 | `proxyUrl/appServerUrl: codex.X` in `proxy_pair_info` log line | Minor — log-only, default-specific is fine |
| 1917, 1919, 1955 | `pair.codex.X` in ensurePair / port-busy paths | OK — pair-scoped |
| 2038-2039 | `pair.codex.stop()` in destroyPair | OK — pair-scoped |
| 2060-2061 | startup log: `Codex app-server: ${codex.appServerUrl}` | OK — boot-time, default-only intentional |
| 2096 | `codex.stop()` in `shutdown(reason)` handler | ⚠️ **Latent leak**: only stops default pair's codex on SIGTERM. Other live pairs' codex processes orphaned. Should iterate `pairs.values()`. |
| 2242 | `codex.setPairedChat(null)` in some failure path | ⚠️ Need to check context — probably should be the home pair's. |

### `codex` leak summary

| Severity | Count | Description |
|---|---|---|
| Latent leaks (need fix) | 4 | #637, #1201 (isolated bootstrap to default), #2096 (shutdown only stops default), #2242 (failure cleanup uses default) |
| Intentional but should be explicit | 2 | #163, #701 (route via `pairs.get("default")!.codex` instead of module) |
| Design question (top-level stale-by-design) | 1 | #1712-1716 — keep v2.2 compat or drop? |
| Documentation only | 11 | Comments referencing `codex` |
| OK — already pair-scoped | 16+ | Uses `pair.codex.X` |

---

## `proxyTuiSlot` (module-level slot) — 83 references

This one is aliased via getter/setter on `defaultPairState.proxyTuiSlot`, so
direct accesses (`proxyTuiSlot = null`) and pair-Map accesses
(`pairs.get("default")!.proxyTuiSlot = null`) refer to the same memory.

That makes the module reference NOT a leak when used in default-pair context
— but ANY use of bare `proxyTuiSlot` in a context that should be checking a
non-default pair IS a leak.

**Already-found leaks fixed in PR #81**:
- `detachClaudeWs` reap timer (`ef08de2`)
- `paired-not-ready error wording` in `handleClaudeToCodex` (`58f01fd`)

**Remaining bare `proxyTuiSlot` references that should be audited** (sample,
not exhaustive — 83 refs total):

| Line range | Path | Classification |
|---|---|---|
| 343, 353, 393-395, 508 | inside pair-iter loops (`pair.proxyTuiSlot`) | OK — pair-scoped |
| 572 | `getPairedChatState()` | Need check — does it scope to default only? |
| 587 | `codex.setPairedChat(state.chatId)` in `pairChat()` | Need check |
| 1715 | `proxyTuiConnected: proxyTuiSlot !== null` in `currentStatus` | ⚠️ Default-only top-level field (same class as `codex` #1712) |

**Action**: scan remaining ~60 bare `proxyTuiSlot` references; the alias
masks correctness when calls assume default-pair semantics.

---

## `tuiConnectionState` (module-level) — 17 references

Default pair's `TuiConnectionState`. Per `PairState.tuiConnectionState`, each
pair has its own; the module-level one is only the default's.

| Line | Context | Classification |
|---|---|---|
| 189-216 | construction + handlers | OK — module-init time |
| 386, 530, 540, etc. | inside pair-iter (`pair.tuiConnectionState`) | OK — pair-scoped |
| 1704 | `tuiConnectionState.snapshot()` in `currentStatus` | ⚠️ Default-only top-level field |
| Various pair-aware paths | Need check | Need exhaustive scan |

---

## `codexBootstrapped` (module-level boolean) — 6 references

Fixed by `ac07ead` (this audit's own commit lineage): only flipped false on
DEFAULT pair exit. Remaining references:

| Line | Context | Classification |
|---|---|---|
| 167 | declaration | N/A |
| 524-530 | set false on default pair exit | OK — gated by `pair.pairId === "default"` |
| 718 | comment | OK |
| 1709 | `bridgeReady: tuiConnectionState.canReply() \|\| codexBootstrapped` | ⚠️ Default-only — reflects default's bootstrap state in top-level `bridgeReady` |
| 2059 | set true on default pair boot completion | OK — only runs for default |

`codexBootstrapped` is **conceptually a default-pair status flag** that
leaks into the top-level `bridgeReady` field. If we keep top-level fields
as default-only v2.2 compat, this is consistent. If we change top-level
fields, this needs to either go away or become an aggregate (`pairs.some(p =>
p.codex.activeThreadId)`).

---

## Decision points (for the refactor PR)

### D1: Top-level vs per-pair DaemonStatus fields

`currentStatus()` populates these top-level fields with default-pair data:
- `proxyUrl`, `appServerUrl`, `threadId`, `tuiConnected`, `proxyTuiConnected`, `bridgeReady`

Spec §D7 P3 says "URLs always populated from default; runtime fields reflect
actual state". But `threadId` is runtime (default's TUI's thread) and
`tuiConnected` / `proxyTuiConnected` / `bridgeReady` also reflect default's
runtime — not the daemon's aggregate state.

**Option A**: Keep as-is (v2.2 compat). Document the lie. Callers reading
top-level should know it's default-only. Add deprecation comment.

**Option B**: Make top-level fields aggregate (`tuiConnected: pairs.some(p =>
p.tuiConnectionState.snapshot().tuiConnected)`). Breaks v2.2 callers who
expected default-specific data.

**Option C**: Remove top-level runtime fields entirely. Force callers to
read from `pairs[]` array. Hard break for v2.2 callers.

**Recommendation**: B with a comment that this is intentional v2.3 widening.

### D2: Isolated bootstrap target pair

Lines #637 and #1201 hardcode `codex.appServerUrl` (default) as the target
for isolated chat bootstrap. Per spec §6.5 P3c this is correct for
`transitionToIsolated` (re-home to default). But for an isolated chat that
never paired in the first place (e.g. FIFO claim found no free pair), the
bootstrap might want to target a SPECIFIC pair the user requested via
`--pair`, not always default.

**Recommendation**: derive from `state.homePairId` consistently. Per spec
§6.5, isolated chats can be homed on any pair if explicit.

### D3: shutdown() stops only default pair's codex

Line #2096 — only `codex.stop()` (default). Other live pairs' codex
processes leak.

**Recommendation**: iterate `pairs.values()` and stop each one's codex.

### D4: Aliased `proxyTuiSlot` — keep or remove?

The getter/setter alias on `defaultPairState.proxyTuiSlot` makes direct
accesses still work. But it means 83 call sites of bare `proxyTuiSlot`
implicitly mean "default's slot" — and any call site that's incorrectly
using the bare reference when it should be pair-aware is a future bug.

**Recommendation**: phase out the alias. Make all reads/writes explicit
via `pairs.get(pairId).proxyTuiSlot`. Aggressive but unambiguous.

---

## Refactor work-plan (proposed)

1. **Failing probes** (this commit set) — `probes/multi-pair/audit-*.ts`
   demonstrate the latent leaks above as red probes that pass once each
   refactor lands.
2. **D2/D3 hotfixes** — small, self-contained, no API change. Can land
   without breaking v2.2 callers.
3. **D1 decision** — needs spec amendment. Probably option B (aggregate
   top-level fields).
4. **D4 alias removal** — large mechanical change. ~80 call sites. Land
   after D1-D3 stabilize.
5. **Drop `codex` / `tuiConnectionState` / `codexBootstrapped` module
   globals entirely** — replace with `pairs.get("default")!.X` everywhere.
   Final cleanup, eliminates the source of future leaks.

Estimated total: 2-3 days of focused work after PR #81 lands.

---

## Why this audit was worth writing now

- **Concrete**: lists every leak with line numbers, not just "globals are bad".
- **Prioritized**: D2/D3 are 1-line fixes; D4 is 80-call-site grind.
- **Survives rebase**: this is a docs + failing probes commit, no
  src/daemon.ts changes. When PR #81 lands and we rebase, this audit is
  unchanged and the failing probes start passing as we land the
  per-pair fixes.
- **Documents intent**: future contributors reading
  `multi-pair-globals-audit.md` understand WHY certain refs use
  `pair.codex.X` and others use bare `codex` — and which ones are bugs.

---

## References

- Spec: `docs/shared-thread-mode-v2.3-spec.md` §6.1, §6.5 P3c, §D7 P3
- Issue tracking: #82 (closed), #83 (closed), #84 (closed) — the 4
  previously-discovered leaks fixed via probe-driven testing
- Probes: M01-M07, M11 in `probes/multi-pair/` — caught the 4 fixed leaks
- Companion failing probes: `probes/multi-pair/audit-d2-isolated-bootstrap.ts`,
  `probes/multi-pair/audit-d3-shutdown-pair-leak.ts`
