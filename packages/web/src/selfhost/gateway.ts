/** The authenticated browser boundary. Connections, running turns and SSH credentials live on the server. */
import { z } from "zod";

const record = z.record(z.string(), z.unknown());
export const hostSchema = z.object({
  id: z.number(),
  avatar: z.string().default("server"),
  name: z.string(),
  sshHost: z.string(),
  username: z.string().nullable(),
  port: z.number().nullable(),
  authMode: z.enum(["agent", "privateKey", "password"]),
  hostKeyType: z.string().optional(),
  hostKeyFingerprint: z.string().nullable().optional(),
  privateKeyPath: z.string().nullable().optional(),
  proxyUrl: z.string().nullable().optional(),
});
export const projectSchema = z.object({
  hostId: z.number(),
  id: z.string().optional(),
  nativeId: z.string().optional(),
  name: z.string(),
  remotePath: z.string(),
  roots: z.array(z.string()).optional(),
  source: z.enum(["registered", "saved", "thread"]).optional(),
  aliases: z.array(z.string()).optional(),
});
export const modelSchema = z.object({
  id: z.string(),
  model: z.string(),
  displayName: z.string(),
  isDefault: z.boolean().optional(),
  inputModalities: z.array(z.string()).optional(),
  defaultReasoningEffort: z.string().nullable().optional(),
  supportedReasoningEfforts: z
    .array(z.object({ reasoningEffort: z.string(), description: z.string().nullable().optional() }))
    .optional(),
});
export type Host = z.infer<typeof hostSchema>;
export type Project = z.infer<typeof projectSchema>;
export type RemoteModel = z.infer<typeof modelSchema>;
export type Message = Record<string, unknown>;
export function object(value: unknown): Message {
  return record.parse(value);
}
export function wireId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

type Flight = {
  resolve: (value: Message) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export class Gateway {
  private socket?: WebSocket;
  private dialing?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private closed = false;
  private readonly pending = new Map<string, Flight>();
  private readonly watchers = new Set<(message: Message) => void>();
  private readonly terminals = new Set<(frame: ArrayBuffer) => void>();
  constructor(
    private readonly token: string,
    private readonly sessionExpired: () => void = () => {},
  ) {}
  static async login(username: string, password: string) {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok)
      throw new Error(response.status === 401 ? "用户名或密码不正确" : String(response.status));
    return z.object({ token: z.string() }).parse(await response.json()).token;
  }
  async request<T>(url: string, schema: z.ZodType<T>, method = "GET", body?: unknown): Promise<T> {
    const response = await this.fetch(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return schema.parse(await response.json());
  }
  async fetch(url: string, options: RequestInit = {}) {
    const target = new URL(url, location.origin);
    if (target.origin !== location.origin || !target.pathname.startsWith("/api/"))
      throw new Error("Invalid gateway endpoint");
    const headers = new Headers(options.headers);
    headers.set("Authorization", "Bearer " + this.token);
    const response = await fetch(target, { ...options, headers });
    if (!response.ok) {
      if (response.status === 401) this.sessionExpired();
      const err = await response.json().catch(() => ({}));
      throw new Error(
        typeof err.message === "string" ? err.message : "Gateway HTTP " + response.status,
      );
    }
    return response;
  }
  on(fn: (message: Message) => void) {
    this.watchers.add(fn);
    return () => {
      this.watchers.delete(fn);
    };
  }
  onTerminal(fn: (frame: ArrayBuffer) => void) {
    this.terminals.add(fn);
    return () => {
      this.terminals.delete(fn);
    };
  }
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Gateway session closed"));
    if (this.dialing) return this.dialing;
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    clearTimeout(this.timer);
    const ws = new WebSocket(
      (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/realtime",
    );
    this.socket = ws;
    ws.binaryType = "arraybuffer";
    this.dialing = new Promise<void>((resolve, reject) => {
      let healthInterval: ReturnType<typeof setInterval> | undefined;
      let probe: { nonce: string; timeout: ReturnType<typeof setTimeout> } | undefined;
      const clearProbe = () => {
        clearTimeout(probe?.timeout);
        probe = undefined;
      };
      const checkConnection = () => {
        if (document.hidden || probe || this.closed || ws.readyState !== WebSocket.OPEN) return;
        const nonce = wireId();
        probe = { nonce, timeout: setTimeout(disconnect, 4000) };
        ws.send(JSON.stringify({ type: "ping", nonce }));
      };
      const disconnect = (event?: CloseEvent) => {
        clearTimeout(handshake);
        clearInterval(healthInterval);
        clearProbe();
        window.removeEventListener("focus", checkConnection);
        document.removeEventListener("visibilitychange", checkConnection);
        if (this.socket !== ws) return;
        this.socket = undefined;
        this.dialing = undefined;
        // 代理静默断线时浏览器可能迟迟收不到 close 帧，心跳超时直接进入现有重连路径。
        if (!event) ws.close();
        reject(new Error("Gateway disconnected"));
        for (const req of this.pending.values()) {
          clearTimeout(req.timer);
          req.reject(new Error("Connection lost. Check remote state before retrying."));
        }
        this.pending.clear();
        if (
          event?.code === 1008 &&
          ["Invalid or expired session", "Session revoked"].includes(event.reason)
        ) {
          this.closed = true;
          this.sessionExpired();
        }
        if (this.closed) return;
        for (const cb of this.watchers) cb({ type: "disconnected" });
        this.timer = setTimeout(
          () => {
            void this.connect().catch(() => {});
          },
          Math.min(10000, 500 * 2 ** Math.min(this.failures++, 5)),
        );
      };
      const handshake = setTimeout(disconnect, 15000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "auth.authenticate", token: this.token }));
      ws.onmessage = ({ data }) => {
        if (this.socket !== ws) return;
        if (data instanceof ArrayBuffer) {
          for (const cb of this.terminals) cb(data);
          return;
        }
        let msg: Message;
        try {
          msg = object(JSON.parse(String(data)));
        } catch {
          return;
        }
        if (msg.type === "ready") {
          clearTimeout(handshake);
          this.dialing = undefined;
          this.failures = 0;
          healthInterval ??= setInterval(checkConnection, 20000);
          window.addEventListener("focus", checkConnection);
          document.addEventListener("visibilitychange", checkConnection);
          resolve();
        }
        if (msg.type === "pong") {
          if (probe && msg.nonce === probe.nonce) clearProbe();
          return;
        }
        const id = msg.requestId;
        if (typeof id === "string") {
          const req = this.pending.get(id);
          if (req) {
            clearTimeout(req.timer);
            this.pending.delete(id);
            if (msg.type === "error" || String(msg.type).endsWith(".error"))
              req.reject(new Error(String(msg.message ?? "Gateway request failed")));
            else req.resolve(msg);
          }
        }
        for (const cb of this.watchers) cb(msg);
      };
      ws.onerror = () => disconnect();
      ws.onclose = disconnect;
    });
    return this.dialing;
  }
  async send(message: Message) {
    await this.connect();
    this.socket!.send(JSON.stringify(message));
  }
  async call(type: string, args: Message = {}, requestId = wireId()): Promise<Message> {
    await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(type + " timed out"));
      }, 75000);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.socket!.send(JSON.stringify({ ...args, type, requestId }));
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(cause);
      }
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.socket?.close();
  }
  hosts() {
    return this.request("/api/hosts", z.array(hostSchema));
  }
  async config() {
    const [hosts, projects] = await Promise.all([
      this.hosts(),
      this.request("/api/selfhost/projects", z.array(projectSchema)),
    ]);
    return { hosts, projects };
  }
  projects(hostId: number, force = false) {
    return this.request(
      "/api/selfhost/projects?hostId=" + hostId + (force ? "&refresh=1" : ""),
      z.array(projectSchema),
    );
  }
  projectCatalog(hostId: number) {
    return this.request(
      "/api/selfhost/projects?" +
        new URLSearchParams({ hostId: String(hostId), organization: "1" }),
      z.object({
        items: z.array(projectSchema),
        memberships: z.record(z.string(), z.string().nullable()),
      }),
    );
  }
  async models(hostId: number) {
    const all: RemoteModel[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ hostId: String(hostId) });
      if (cursor) query.set("cursor", cursor);
      const page: { data: RemoteModel[]; nextCursor?: string | null } = await this.request(
        "/api/models?" + query,
        z.object({ data: z.array(modelSchema), nextCursor: z.string().nullable().optional() }),
      );
      all.push(...page.data);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return all;
  }
}
