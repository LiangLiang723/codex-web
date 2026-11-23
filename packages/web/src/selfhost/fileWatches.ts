import { Gateway, wireId, type Message } from "./gateway.js";
import type { FileWatchEvent } from "@zcode/shared";

type Watch = { id: string; path: string; subscriptionId: string };

/** Maps ZCode's individual directory handles to Gateway's authenticated fs/watch leases. */
export class FileWatches {
  private readonly watches = new Map<string, Watch>();
  private readonly unsubscribe: () => void;

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
    const watch = { id: wireId(), path, subscriptionId: wireId() };
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
      for (const watch of this.watches.values()) {
        watch.subscriptionId = wireId();
        void this.subscribe(watch)
          .then(() => {
            if (this.watches.has(watch.id)) this.changed(watch.id, { dirPath: watch.path });
          })
          .catch(() => {});
      }
      return;
    }
    if (message.type !== "file.watch.changed" && message.type !== "file.watch.closed") return;
    const watch = this.watches.get(String(message.threadId));
    if (!watch || message.hostId !== this.hostId || message.cwd !== watch.path) return;
    const paths = message.paths;
    const changedPath =
      Array.isArray(paths) && paths.length === 1 && typeof paths[0] === "string"
        ? paths[0]
        : undefined;
    this.changed(watch.id, { dirPath: watch.path, changedPath });
  }
}
