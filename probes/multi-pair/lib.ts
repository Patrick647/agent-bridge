#!/usr/bin/env bun
/**
 * Multi-pair probe harness for STM v2.3 §10 (M01-M12).
 *
 * Composes the shared-thread probe harness (single daemon, control-WS,
 * TUI / Claude clients) with multi-pair management RPCs (ensure_pair,
 * destroy_pair, list_pairs) and per-pair URL routing.
 *
 * Each test pair brings up its own real codex app-server (via
 * ensure_pair). Probes run real Codex CLI binaries; this is heavy but
 * matches what the corresponding M01-M12 specs describe.
 */
import { randomBytes } from "node:crypto";
import {
  ClaudeClient,
  ProbeFailure,
  RawWsClient,
  SharedThreadProbe,
  TuiClient,
  assert,
  sleep,
  withTimeout,
  type Json,
  type ProbeOptions,
  type TuiOptions,
} from "../shared-thread/lib";

export interface PairListEntry {
  pairId: string;
  isLive: boolean;
  appServerUrl: string;
  proxyUrl: string;
  tuiConnected: boolean;
  proxyTuiConnected: boolean;
  pairedChatId: string | null;
  threadId: string | null;
  attachedClaudes: Array<{ chatId: string; paired: boolean }>;
}

export interface PairEnsuredResponse {
  pairId: string;
  appServerUrl: string;
  proxyUrl: string;
}

export class MultiPairProbe extends SharedThreadProbe {
  /**
   * Open a one-shot WS to the daemon's control port, send a typed
   * request, wait for the matching response by requestId. Resolves with
   * the parsed response or throws on timeout / pair_error mismatch.
   */
  private async controlRpc<T extends Json>(
    request: Json & { type: string },
    expectedTypes: string[],
    timeoutMs = 15_000,
  ): Promise<T> {
    const requestId = `probe_${Date.now()}_${randomBytes(3).toString("hex")}`;
    const payload = { ...request, requestId };

    const ws = new WebSocket(this.controlUrl);
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          ws.onopen = () => resolve();
          ws.onerror = () => reject(new ProbeFailure(`controlRpc ${request.type} WS open failed`));
        }),
        timeoutMs,
        `controlRpc ${request.type} open`,
      );

      ws.send(JSON.stringify(payload));

      return await withTimeout(
        new Promise<T>((resolve, reject) => {
          ws.onmessage = (event) => {
            const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf-8");
            let parsed: any;
            try { parsed = JSON.parse(raw); } catch { return; }
            if (parsed?.requestId !== requestId) return;
            if (!expectedTypes.includes(parsed.type)) return;
            resolve(parsed as T);
          };
          ws.onerror = () => reject(new ProbeFailure(`controlRpc ${request.type} WS error`));
          ws.onclose = () => reject(new ProbeFailure(`controlRpc ${request.type} WS closed before response`));
        }),
        timeoutMs,
        `controlRpc ${request.type} response`,
      );
    } finally {
      try { ws.close(); } catch {}
    }
  }

  /** Send ensure_pair, await pair_ensured. Throws on pair_error. */
  async ensurePair(pairId: string): Promise<PairEnsuredResponse> {
    const response = await this.controlRpc<{
      type: "pair_ensured" | "pair_error";
      pairId: string;
      appServerUrl?: string;
      proxyUrl?: string;
      code?: string;
      message?: string;
    }>({ type: "ensure_pair", pairId }, ["pair_ensured", "pair_error"]);

    if (response.type === "pair_error") {
      throw new ProbeFailure(`ensure_pair(${pairId}) returned pair_error: ${response.code ?? "?"} ${response.message ?? ""}`);
    }
    this.log(`ensure_pair ${pairId} → appServer=${response.appServerUrl} proxy=${response.proxyUrl}`);
    return {
      pairId: response.pairId,
      appServerUrl: response.appServerUrl!,
      proxyUrl: response.proxyUrl!,
    };
  }

  /** Send destroy_pair. Returns the response (success or error) for the caller to inspect. */
  async destroyPair(
    pairId: string,
    opts: { forget?: boolean; force?: boolean } = {},
  ): Promise<{ type: "pair_destroyed" | "pair_error"; code?: string; message?: string; forgotten?: boolean }> {
    const response = await this.controlRpc<{
      type: "pair_destroyed" | "pair_error";
      pairId: string;
      forgotten?: boolean;
      code?: string;
      message?: string;
    }>(
      { type: "destroy_pair", pairId, forget: opts.forget ?? false, force: opts.force ?? false },
      ["pair_destroyed", "pair_error"],
    );
    this.log(`destroy_pair ${pairId} → ${response.type}${response.code ? ` (${response.code})` : ""}`);
    return response;
  }

  /** Send list_pairs, return the entries. */
  async listPairs(): Promise<PairListEntry[]> {
    const response = await this.controlRpc<{
      type: "pair_list";
      pairs: PairListEntry[];
    }>({ type: "list_pairs" }, ["pair_list"]);
    return response.pairs;
  }

  /** Connect a TUI to a specific pair's proxy port (ensures the pair first). */
  async connectTuiOnPair(
    pairId: string,
    token: string,
    name?: string,
    options?: TuiOptions,
  ): Promise<TuiClient> {
    const { proxyUrl } = await this.ensurePair(pairId);
    const client = new TuiClient(this, name ?? `tui-${pairId}`, proxyUrl, options, {
      headers: { authorization: `Bearer ${token}` },
    });
    await client.connect();
    return client;
  }

  /** Connect a Claude bridge with an optional explicit pairId selector. */
  async connectClaudeOnPair(chatId: string, pairId?: string): Promise<ClaudePairClient> {
    const client = new ClaudePairClient(this, chatId, pairId);
    await client.connect();
    return client;
  }
}

/**
 * Claude client that adds the v2.3 §D4 pairId + requestId fields to
 * claude_connect, and captures the typed claude_connect_result response
 * (which the base ClaudeClient ignores).
 */
export class ClaudePairClient extends ClaudeClient {
  readonly connectResults: Array<{
    type: "claude_connect_result";
    ok: boolean;
    chatId?: string;
    homePairId?: string;
    paired?: boolean;
    error?: string;
    pairId?: string;
    requestId?: string;
  }> = [];
  private readonly connectRequestId: string;

  constructor(probe: MultiPairProbe, chatId: string, readonly pairId?: string) {
    super(probe, chatId);
    this.connectRequestId = `connect_${chatId}_${Date.now()}_${randomBytes(2).toString("hex")}`;
  }

  override async connect(timeoutMs = 20_000): Promise<void> {
    // Call RawWsClient.connect via the chain so we open the WS without
    // ClaudeClient's default claude_connect (we send our own variant
    // with pairId + requestId below).
    await RawWsClient.prototype.connect.call(this, timeoutMs);
    const payload: Json = {
      type: "claude_connect",
      chatId: this.chatId,
      requestId: this.connectRequestId,
    };
    if (this.pairId !== undefined) payload.pairId = this.pairId;
    this.send(payload);
  }

  protected override onMessage(message: Json | null, raw: string): void {
    super.onMessage(message, raw);
    if (message?.type === "claude_connect_result" && message.requestId === this.connectRequestId) {
      this.connectResults.push(message as any);
    }
  }

  /** Wait for the claude_connect_result corresponding to this client's connect. */
  async waitForConnectResult(timeoutMs = 10_000): Promise<{
    ok: boolean;
    error?: string;
    homePairId?: string;
    paired?: boolean;
  }> {
    return withTimeout(
      new Promise((resolve) => {
        const poll = () => {
          const found = this.connectResults.find((r) => r.requestId === this.connectRequestId);
          if (found) resolve({
            ok: Boolean(found.ok),
            error: found.error,
            homePairId: found.homePairId,
            paired: found.paired,
          });
          else setTimeout(poll, 50);
        };
        poll();
      }),
      timeoutMs,
      `${this.name} claude_connect_result`,
    );
  }
}

/**
 * Wrap a probe body with daemon spawn + final teardown. Same shape as
 * shared-thread `runProbe` but binds to MultiPairProbe.
 */
export async function runMultiPairProbe(
  name: string,
  fn: (probe: MultiPairProbe) => Promise<void>,
  options?: Omit<ProbeOptions, "name">,
): Promise<void> {
  // Move pair-registry stride range well above the user's running
  // daemon's named-pair allocations (default STRIDE_BASE=4510). Without
  // this, `ensure_pair("work")` on the probe daemon would try to bind
  // port 4510 — colliding with whatever the developer has running.
  // Probe daemons get a much higher base so they coexist with a live
  // local install.
  const probeStrideBase = options?.extraEnv?.AGENTBRIDGE_PAIR_STRIDE_BASE ?? "24510";
  const extraEnv = {
    AGENTBRIDGE_PAIR_STRIDE_BASE: probeStrideBase,
    ...options?.extraEnv,
  };
  const probe = new MultiPairProbe({ name, ...options, extraEnv });
  let failed = false;
  try {
    await probe.startDaemon();
    await fn(probe);
  } catch (err: any) {
    failed = true;
    probe.log(`ERROR: ${err?.stack ?? err}`);
  } finally {
    await probe.stop();
  }
  probe.log(failed ? "RESULT: FAILED" : "RESULT: PASSED");
  process.exit(failed ? 1 : 0);
}

export { assert, sleep, withTimeout, ProbeFailure } from "../shared-thread/lib";
export { makeToken, marker } from "../shared-thread/lib";
