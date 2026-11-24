import { Gateway, wireId, type Message } from "./gateway.js";
import type { FileWatchEvent } from "@zcode/shared";

type Watch = { id: string; path: string; subscriptionId: string; needsLease: boolean };

/** Maps ZCode's individual directory handles to Gateway's authenticated fs/watch leases. */
export class FileWatches {
  private readonly watches = new Map<string, Watch>();
  private readonly unsubscribe: () => void;
  private connected = false;

  constructor(
    private readonly gateway: Gateway,
    private readonly hostId: number,
    private readonly changed: (id: string, event: FileWatchEvent) => void,
  ) {
    this.unsubscribe = gateway.on((message) => this.onMessage(message));
  }

  async watch(path: string, recursive: boolean) {
    if (!path.startsWith("/")) throw Error("需要远程绝对路径");
    if (recursive) throw Error("远程 Codex 支持按已展开的目录监听");
    await this.gateway.connect();
    const watch = { id: wireId(), path, subscriptionId: wireId(), needsLease: false };
    this.watches.set(watch.id, watch);
    try {
      await this.subscribe(watch);
      return { id: watch.id };
    } catch (error) {
      // A timed-out request may already own a server-side lease.
      await this.unwatch(watch.id);
      throw error;
    }
  }

  async unwatch(id: string) {
    const watch = this.watches.get(id);
    if (!watch) return;
    this.watches.delete(id);
    await this.gateway
      .send({
        type: "file.watch.unsubscribe",
        hostId: this.hostId,
        cwd: watch.path,
        threadId: id,
        subscriptionId: watch.subscriptionId,
      })
      .catch(() => {}); // Gateway also releases all peer-owned watches on disconnect.
  }

  clear() {
    return Promise.all(Array.from(this.watches.keys(), (id) => this.unwatch(id))).then(() => {});
  }

  dispose() {
    this.unsubscribe();
    void this.clear();
  }

  private subscribe(watch: Watch) {
    // Gateway uses threadId only as the namespace of a peer's file subscription.
    return this.gateway.call(
      "file.watch.subscribe",
      {
        hostId: this.hostId,
        cwd: watch.path,
        threadId: watch.id,
        paths: [watch.path],
      },
      watch.subscriptionId,
    );
  }

  private onMessage(message: Message) {
    if (message.type === "ready") {
      this.connected = false;
      for (const watch of this.watches.values()) this.restore(watch);
      return;
    }
    if (message.type === "host.lifecycle") {
      const host = message.event as Message | undefined;
      if (host?.hostId !== this.hostId) return;
      this.connected = host.status === "connected";
      if (this.connected) {
        for (const watch of this.watches.values()) if (watch.needsLease) this.restore(watch);
      } else {
        for (const watch of this.watches.values()) watch.needsLease = true;
      }
      return;
    }
    if (message.type !== "file.watch.changed" && message.type !== "file.watch.closed") return;
    const watch = this.watches.get(String(message.threadId));
    if (!watch || message.hostId !== this.hostId || message.cwd !== watch.path) return;
    if (message.subscriptionId && message.subscriptionId !== watch.subscriptionId) return;
    if (message.type === "file.watch.closed") {
      watch.needsLease = true;
      if (this.connected) this.restore(watch);
    }
    const paths = message.paths;
    const changedPath =
      Array.isArray(paths) && paths.length === 1 && typeof paths[0] === "string"
        ? paths[0]
        : undefined;
    this.changed(watch.id, { dirPath: watch.path, changedPath });
  }
  private restore(watch: Watch) {
    // SSH 可以独立于浏览器重连。只让当前目录句柄最新一代的租约触发补读。
    const generation = wireId();
    watch.subscriptionId = generation;
    watch.needsLease = false;
    void this.subscribe(watch)
      .then(() => {
        if (this.watches.get(watch.id) === watch && watch.subscriptionId === generation)
          this.changed(watch.id, { dirPath: watch.path });
      })
      .catch(() => {
        if (watch.subscriptionId === generation) watch.needsLease = true;
      });
  }
}
