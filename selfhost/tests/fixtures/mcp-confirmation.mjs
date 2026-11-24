// 测试专用的 stdio MCP 服务。通过官方 Codex 发出只读数字表单；无需网络或凭据。
import { createInterface } from "node:readline";
const pending = new Map();
let sequence = 0;
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const msg = JSON.parse(line);
  if (msg.method === "initialize")
    send({
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "zcode-approval-check", version: "1" },
      },
    });
  else if (msg.method === "ping") send({ id: msg.id, result: {} });
  else if (msg.method === "tools/list")
    send({
      id: msg.id,
      result: {
        tools: [
          {
            name: "confirm_count",
            description: "Ask the user to confirm a test number",
            inputSchema: {
              type: "object",
              properties: { variant: { type: "string", enum: ["form", "url", "openai/form"] } },
            },
          },
        ],
      },
    });
  else if (msg.method === "tools/call" && msg.params.name === "confirm_count") {
    const id = ++sequence;
    pending.set(id, msg.id);
    const mode = msg.params.arguments?.variant ?? "form";
    const params =
      mode === "url"
        ? {
            mode,
            elicitationId: "qa-link-" + id,
            url: "https://example.org/",
            message: "ZCode approval check",
          }
        : {
            mode,
            message: "ZCode approval check",
            requestedSchema: {
              type: "object",
              properties: { count: { type: "integer", title: "Count", minimum: 1 } },
              required: ["count"],
            },
          };
    send({ id, method: "elicitation/create", params });
  } else if (!msg.method && pending.has(msg.id)) {
    const id = pending.get(msg.id);
    pending.delete(msg.id);
    send({
      id,
      result: { content: [{ type: "text", text: JSON.stringify(msg.result ?? msg.error) }] },
    });
  } else if (msg.method && msg.id !== undefined)
    send({ id: msg.id, error: { code: -32601, message: "Unknown method" } });
}
