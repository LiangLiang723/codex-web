import { readBody } from "h3";
import { z } from "zod";
import { defineGatewayEventHandler } from "../../utils/gateway/http/errors";
import { hostCreateSchema } from "../../utils/gateway/http/validation/hosts-projects";
import { sshConnections } from "../../utils/gateway/infra/host-services";
import { hostStore } from "../../utils/gateway/state/hosts";

const draftSchema = z
  .object({
    hostId: z.number().int().positive().optional(),
    host: hostCreateSchema,
  })
  .strict();

function failureStatus(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/fingerprint|known_hosts|host key|hostkey/i.test(message)) return "hostKey";
  if (/deadline|timed? ?out|ETIMEDOUT/i.test(message)) return "timeout";
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|connection refused/i.test(message))
    return "unreachable";
  if (/identity file|private ?key|passphrase|ENOENT/i.test(message)) return "privateKey";
  if (/auth|username|permission denied/i.test(message)) return "authentication";
  if (/proxy|socks/i.test(message)) return "proxy";
  return "failed";
}

export default defineGatewayEventHandler(async (event) => {
  const draft = draftSchema.safeParse(await readBody(event));
  if (!draft.success) return { status: "invalid" };
  const host = hostStore.preview(draft.data.host, draft.data.hostId);
  if (host === null) return { status: "invalid" };
  const disconnected = new AbortController();
  const response = event.node.res;
  const cancel = () => disconnected.abort();
  response.once("close", cancel);
  if (response.destroyed) cancel();
  try {
    // 独立试连不会进入主机连接池的租约、MFA 或 Codex 启动流程。
    const status = await sshConnections.testAuthentication(
      host,
      AbortSignal.any([disconnected.signal, AbortSignal.timeout(35_000)]),
    );
    return { status };
  } catch (error) {
    // 草稿有私钥和口令，失败只返回已知阶段，避免回显底层错误的输入值。
    return { status: disconnected.signal.aborted ? "canceled" : failureStatus(error) };
  } finally {
    response.removeListener("close", cancel);
  }
});
