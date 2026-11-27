import { createMemoryStorage, installSelfhostBrowserStorage } from "@zcode/ui/browser-environment";
import { z } from "zod";
import type { Gateway } from "./gateway.js";

const endpoint = "/api/selfhost/browser-state";
const stateSchema = z.record(z.string(), z.string());
const mirroredLocaleKeys = new Set(["zcode-locale-preference", "zcode-locale"]);
const durableTabPreference = "zcode-automations-page-tab";
const accounts = new WeakMap<Gateway, AccountBrowserState>();
const appKey = /^(?:zcode[-.:]|codex-web:|react-resizable-panels:)/u;
const encoder = new TextEncoder();
type PendingValue = { value: string | null };

function previousStorage(kind: "localStorage" | "sessionStorage") {
  try {
    const storage = window[kind];
    const entries = new Map<string, string>();
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key || !appKey.test(key)) continue;
      const value = storage.getItem(key);
      if (value !== null) entries.set(key, value);
    }
    return {
      entries,
      clearImported() {
        for (const [key, value] of entries) {
          if (storage.getItem(key) === value) storage.removeItem(key);
        }
      },
    };
  } catch {
    return undefined;
  }
}

function writeBatch(pending: ReadonlyMap<string, PendingValue>, importLegacy = false) {
  const saving = new Map<string, PendingValue>();
  let size = 34;
  for (const [key, change] of pending) {
    const bytes = encoder.encode(JSON.stringify([key, change.value])).length + 1;
    if (saving.size && (size + bytes > 8 * 1024 * 1024 || saving.size >= 1024)) break;
    saving.set(key, change);
    size += bytes;
  }
  const body = JSON.stringify({
    changes: [...saving].map(([key, change]) => [key, change.value]),
    ...(importLegacy ? { importLegacy } : {}),
  });
  return { saving, body, size };
}

async function load(
  gateway: Gateway,
  legacy: Map<string, PendingValue>,
  signal: AbortSignal,
) {
  let state: Record<string, string> | undefined;
  while (legacy.size) {
    const { saving, body } = writeBatch(legacy, true);
    const response = await gateway.fetch(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
      signal,
    });
    state = stateSchema.parse(await response.json());
    for (const key of saving.keys()) legacy.delete(key);
  }
  return state ?? gateway.request(endpoint, stateSchema, "GET", undefined, signal);
}

export async function openAccountBrowserState(
  gateway: Gateway,
  importLegacy: boolean,
  signal: AbortSignal,
  onFailure: (failed: boolean) => void,
) {
  const previous = previousStorage("localStorage");
  const previousPage = previousStorage("sessionStorage");
  const legacy = new Map<string, PendingValue>();
  if (importLegacy) {
    for (const [key, value] of previous?.entries ?? []) legacy.set(key, { value });
    const tab = previousPage?.entries.get(durableTabPreference);
    if (tab && !legacy.has(durableTabPreference)) legacy.set(durableTabPreference, { value: tab });
  }
  const state = await load(gateway, legacy, signal);
  signal.throwIfAborted();
  // 先确认数据库已提交，再清理旧版本的应用键。新账号不会接收未署名的旧数据。
  previous?.clearImported();
  previousPage?.clearImported();
  const account = new AccountBrowserState(gateway, state, signal, onFailure);
  accounts.set(gateway, account);
  installSelfhostBrowserStorage(account.storage);
  return account.storage;
}

export function flushBrowserState(gateway: Gateway): Promise<void> | undefined {
  return accounts.get(gateway)?.flush();
}

class AccountBrowserState {
  readonly storage: Storage;
  private readonly pending = new Map<string, PendingValue>();
  private inFlight?: Promise<void>;

  constructor(
    private readonly gateway: Gateway,
    initial: Record<string, string>,
    private readonly signal: AbortSignal,
    private readonly onFailure: (failed: boolean) => void,
  ) {
    this.storage = createMemoryStorage(initial, (key, value) => {
      if (signal.aborted || mirroredLocaleKeys.has(key) || !appKey.test(key)) return;
      this.pending.set(key, { value });
      queueMicrotask(() => this.retry());
    });
    window.addEventListener("online", this.retry, { signal });
  }

  private retry = () => {
    void this.flush().catch(() => {});
  };

  flush(): Promise<void> {
    if (this.signal.aborted || this.pending.size === 0) return Promise.resolve();
    return (this.inFlight ??= this.persist().finally(() => {
      this.inFlight = undefined;
    }));
  }

  private async persist() {
    try {
      while (this.pending.size) {
        const { saving, body, size } = writeBatch(this.pending);
        await this.gateway.fetch(endpoint, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body,
          signal: this.signal,
          keepalive: size < 60 * 1024,
        });
        for (const [key, change] of saving) {
          if (this.pending.get(key) === change) this.pending.delete(key);
        }
      }
      this.onFailure(false);
    } catch (error) {
      if (!this.signal.aborted) this.onFailure(true);
      throw error;
    }
  }
}
