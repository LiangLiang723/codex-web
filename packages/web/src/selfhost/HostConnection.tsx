import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useZCodeIntl } from "@zcode/ui";
import { Button } from "@zcode/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@zcode/ui/dialog";
import { Input } from "@zcode/ui/input";
import { z } from "zod";
import type { Gateway, Message } from "./gateway.js";
import { rec } from "./nativeValues.js";

const hostIdSchema = z.number().int().positive();
const lifecycleSchema = z.object({
  hostId: hostIdSchema,
  status: z.enum([
    "connecting",
    "checkingVersion",
    "upgrading",
    "restarting",
    "connected",
    "failed",
    "mfaRequired",
    "canceled",
  ]),
  message: z.string().optional(),
});
const challengeSchema = z.object({
  hostId: hostIdSchema,
  instructions: z.string(),
  prompts: z.array(z.object({ prompt: z.string(), echo: z.boolean().optional() })).min(1),
});

type ConnectionStatus = z.infer<typeof lifecycleSchema>["status"];
type Challenge = z.infer<typeof challengeSchema> & { revision: number };
type Connection = {
  status: ConnectionStatus;
  challenge?: Challenge;
  message?: string;
  sendFailed?: boolean;
};
export type HostConnections = Record<number, Connection>;
const emptyConnections: HostConnections = {};

export const hostConnectionMessages = {
  connecting: "selfhost.network.sshConnecting",
  checkingVersion: "selfhost.network.sshPreparing",
  upgrading: "selfhost.network.sshPreparing",
  restarting: "selfhost.network.sshPreparing",
  failed: "selfhost.network.sshFailed",
  mfaRequired: "selfhost.network.sshMfaRequired",
  canceled: "selfhost.network.sshCanceled",
} as const;

export function hostConnectionPending(status?: ConnectionStatus) {
  return (
    status === "connecting" ||
    status === "checkingVersion" ||
    status === "upgrading" ||
    status === "restarting"
  );
}

export async function waitForHostConnection(gateway: Gateway, hostId: number, signal: AbortSignal) {
  await gateway.connect();
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      off();
      signal.removeEventListener("abort", cancel);
    };
    const fail = (error: unknown) => {
      stop();
      reject(error);
    };
    const cancel = () => {
      fail(signal.reason);
      try {
        gateway.sendOnReadyConnection({ type: "host.mfa.cancel", hostId });
      } catch {
        // 旧 WebSocket 已断开时不能把对旧连接的取消发送给新连接。
      }
    };
    const off = gateway.on((message) => {
      if (message.type === "disconnected") {
        fail(new Error("Gateway disconnected"));
        return;
      }
      const request = rec(message.request);
      if (
        message.type === "error" &&
        request.type === "host.mfa.connect" &&
        request.hostId === hostId
      ) {
        fail(
          new Error(
            typeof message.message === "string" ? message.message : "SSH connection failed",
          ),
        );
        return;
      }
      if (message.type !== "host.lifecycle") return;
      const event = lifecycleSchema.safeParse(message.event);
      if (!event.success || event.data.hostId !== hostId) return;
      if (event.data.status === "connected") {
        stop();
        resolve();
      } else if (event.data.status === "failed" || event.data.status === "canceled") {
        fail(new Error(event.data.message || event.data.status));
      }
    });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      gateway.sendOnReadyConnection({ type: "host.mfa.connect", hostId });
    } catch (error) {
      fail(error);
    }
  });
}

export function useHostConnections(gateway: Gateway) {
  const [state, setState] = useState(() => ({ gateway, hosts: emptyConnections }));
  const latest = useRef(state);
  const publish = useCallback(
    (hosts: HostConnections) => {
      const snapshot = { gateway, hosts };
      latest.current = snapshot;
      setState(snapshot);
    },
    [gateway],
  );
  const update = useCallback(
    (hostId: number, connection: Connection) => {
      const previous = latest.current;
      publish({
        ...(previous.gateway === gateway ? previous.hosts : emptyConnections),
        [hostId]: connection,
      });
    },
    [gateway, publish],
  );

  useEffect(() => {
    let revision = 0;
    return gateway.onHostConnection((message) => {
      if (message.type === "disconnected") {
        publish(emptyConnections);
      } else if (message.type === "host.lifecycle") {
        const event = lifecycleSchema.safeParse(message.event);
        if (event.success)
          update(event.data.hostId, { status: event.data.status, message: event.data.message });
      } else if (message.type === "host.mfa.request") {
        const challenge = challengeSchema.safeParse(message);
        if (challenge.success)
          update(challenge.data.hostId, {
            status: "mfaRequired",
            challenge: { ...challenge.data, revision: ++revision },
          });
      }
    });
  }, [gateway, publish, update]);

  const send = (hostId: number, message: Message, nextState: Connection): boolean => {
    try {
      // 答案只对当前已认证的连接有效，重连后等服务器重放挑战，不能补发原回答。
      gateway.sendOnReadyConnection({ ...message, hostId });
      update(hostId, nextState);
      return true;
    } catch {
      const previous = latest.current.hosts[hostId];
      update(hostId, { status: previous?.status ?? "failed", sendFailed: true });
      return false;
    }
  };

  return {
    connections: state.gateway === gateway ? state.hosts : emptyConnections,
    connect: (hostId: number) =>
      send(hostId, { type: "host.mfa.connect" }, { status: "connecting" }),
    cancel: (hostId: number) => send(hostId, { type: "host.mfa.cancel" }, { status: "canceled" }),
    respond: (challenge: Challenge, code: string | null) => {
      const { hostId } = challenge;
      // 事件可能已清除或替换挑战，但 React 尚未关闭旧表单。
      if (
        latest.current.gateway !== gateway ||
        latest.current.hosts[hostId]?.challenge !== challenge
      )
        return false;
      return code === null
        ? send(hostId, { type: "host.mfa.cancel" }, { status: "canceled" })
        : send(hostId, { type: "host.mfa.submit", code }, { status: "connecting" });
    },
  };
}

export function HostMfaDialog({
  hostName,
  challenge,
  onRespond,
}: {
  hostName: string;
  challenge: Challenge;
  onRespond: (code: string | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const cancel = () => onRespond(null);
  const prompt = challenge.prompts.length === 1 ? challenge.prompts[0] : undefined;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt) return;
    const code = new FormData(event.currentTarget).get("code");
    if (typeof code !== "string" || !code.trim()) return;
    event.currentTarget.reset();
    onRespond(code);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
        data-testid="selfhost-ssh-mfa-dialog"
      >
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "selfhost.network.sshVerify" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "selfhost.network.sshMfaRequired" }, { host: hostName })}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} autoComplete="off" className="grid gap-4">
          {challenge.instructions ? (
            <p className="whitespace-pre-wrap break-words text-ui-sm">{challenge.instructions}</p>
          ) : null}
          {prompt ? (
            <label className="grid min-w-0 gap-2 break-words text-ui-sm">
              {prompt.prompt || intl.formatMessage({ id: "selfhost.network.sshCode" })}
              <Input
                name="code"
                type={prompt.echo ? "text" : "password"}
                autoComplete="off"
                required
              />
            </label>
          ) : (
            <p className="text-ui-sm text-foreground-subtle" role="status">
              {intl.formatMessage({ id: "selfhost.network.sshMultiplePrompts" })}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={cancel}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            {prompt ? (
              <Button type="submit">{intl.formatMessage({ id: "common.confirm" })}</Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
