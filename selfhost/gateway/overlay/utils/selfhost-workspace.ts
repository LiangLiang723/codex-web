import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { ClientChannel } from "ssh2";
import { sshConnections } from "./gateway/infra/host-services";
import { remoteLoginShellCommand } from "./gateway/infra/ssh/remote-command";
import type { HostWithSecret } from "./gateway/infra/ssh/ssh-types";

type Request = { channel: string; method: string; args: unknown[] };
type Reply = { ready?: boolean; id?: string; error?: string; value?: unknown };
type Worker = { call: (request: Request) => Promise<unknown> };
const workers = new Map<string, Promise<Worker>>();
const deadline = 90000;
function startWorker(channel: ClientChannel, source: Buffer, remove: () => void): Promise<Worker> {
  return new Promise((resolve, reject) => {
    const pending = new Map<string, { done: (value: unknown) => void; fail: (e: Error) => void }>();
    let ready = false;
    const startup = setTimeout(() => {
      channel.close();
      reject(Error("Remote Node workspace failed to start"));
    }, 20000);
    let idle: ReturnType<typeof setTimeout>;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        if (pending.size === 0) channel.end();
        else touch();
      }, 300000);
      idle.unref();
    };
    channel.stderr.resume();
    const close = () => {
      clearTimeout(startup);
      clearTimeout(idle);
      remove();
      const e = Error("Remote workspace closed. Check Node.js on the selected SSH host.");
      reject(e);
      for (const p of pending.values()) p.fail(e);
      pending.clear();
    };
    channel.once("close", close);
    channel.once("error", close);
    const lines = createInterface({ input: channel, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let msg: Reply;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.ready && !ready) {
        ready = true;
        clearTimeout(startup);
        touch();
        resolve({
          call(request) {
            return new Promise((done, fail) => {
              const id = randomUUID();
              const timer = setTimeout(() => {
                pending.delete(id);
                fail(Error("Remote workspace operation timed out"));
              }, deadline);
              pending.set(id, {
                done(v) {
                  clearTimeout(timer);
                  done(v);
                },
                fail(e) {
                  clearTimeout(timer);
                  fail(e);
                },
              });
              try {
                channel.write(JSON.stringify({ ...request, id }) + "\n");
                touch();
              } catch (e) {
                pending.get(id)?.fail(e as Error);
                pending.delete(id);
              }
            });
          },
        });
        return;
      }
      if (!msg.id) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      touch();
      if (msg.error) p.fail(Error(msg.error));
      else p.done(msg.value);
    });
    channel.write(source);
  });
}
export async function callWorkspace(host: HostWithSecret, request: Request) {
  const key = sshConnections.connectionKeyFor(host);
  let worker = workers.get(key);
  if (!worker) {
    const remove = () => {
      if (workers.get(key) === worker) workers.delete(key);
    };
    worker = (async () => {
      const source = await readFile(
        join(process.env.SELFHOST_ASSET_DIR || "/app/selfhost-assets", "workspace.cjs"),
      );
      // Only the release asset length enters the command. All user paths, arguments and content use JSON on stdin.
      const script = [
        "umask 077",
        "d=$(mktemp -d) || exit 1",
        `trap 'rm -f "$d/workspace.cjs"; rmdir "$d"' EXIT`,
        `head -c ` + source.length + ` > "$d/workspace.cjs" || exit 1`,
        `node "$d/workspace.cjs"`,
      ].join("\n");
      const channel = await sshConnections.execChannel(host, remoteLoginShellCommand(script));
      return startWorker(channel, source, remove);
    })();
    workers.set(key, worker);
    worker.catch(remove);
  }
  return (await worker).call(request);
}
