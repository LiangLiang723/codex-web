import type { Gateway, Message } from "./gateway.js";
import type { RemoteServiceAccess } from "@zcode/client";

/** One authenticated gateway user and one verified SSH host own each mounted workbench. */
export type OpenRemoteWorkspace = (
  gateway: Gateway,
  hostId: number,
  cwd: string,
  manage: () => void,
  onThreadDeleted?: (threadId: string) => void,
  initialPreferences?: Promise<Message>,
) => Promise<{
  services: RemoteServiceAccess;
  /** Remove browser subscriptions while leaving the official remote app-server and turns running. */
  dispose(): void;
}>;
