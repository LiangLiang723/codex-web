import { parseThreadReadResult } from "~~/shared/runtime/app-server";
import type { HostRecord } from "~~/shared/types";
import { CodexRpcError } from "./gateway/http/errors";
import { threadBroker } from "./gateway/runtime/broker";

export async function readSelfhostThreadSummary(host: HostRecord, threadId: string) {
  try {
    const result = parseThreadReadResult(
      await threadBroker.selfhostCapability(host, "thread/read", { threadId, includeTurns: false }),
    );
    return result.thread;
  } catch (error) {
    if (
      error instanceof CodexRpcError &&
      /thread (?:not found|does not exist)|no rollout found for thread|^thread not loaded:/i.test(
        error.message,
      )
    )
      return null;
    throw error;
  }
}
