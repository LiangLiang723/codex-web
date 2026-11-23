declare module "virtual:gateway-terminal-stream" {
  export function timelinePageToTurns(page: unknown): Record<string, unknown>[];
  export function mergeThreadTurns(
    history: unknown,
    thread: unknown,
    id: string,
    turns: Record<string, unknown>[],
    direction: "prepend" | "append",
  ): unknown;
  export function applyCanonicalEventToHistory(
    history: unknown,
    thread: unknown,
    id: string,
    event: Record<string, unknown>,
  ): unknown;
  export function decodeTerminalStreamFrame(
    data: Uint8Array,
  ): { opcode: number; sessionId: string; payload: Uint8Array } | null;
  export function decodeTerminalTextPayload(frame: {
    opcode: number;
    sessionId: string;
    payload: Uint8Array;
  }): string | null;
}

declare module "virtual:zcode-projection-state" {
  type Snapshot = import("@zcode/shared/zcode-protocol-v4").ConversationSnapshot;
  export function createInitialConversationSnapshot(id: string, epoch: string): Snapshot;
  export function computeAvailability(ctx: Record<string, unknown>): Snapshot["availability"];
  export function computeInputRouting(
    ctx: Record<string, unknown>,
    behavior: "queue" | "guide",
  ): Snapshot["inputRouting"];
}
