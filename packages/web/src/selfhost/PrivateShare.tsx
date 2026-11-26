import { useEffect, useState, type ReactNode } from "react";
import { z } from "zod";
import { ZCodeIntlProvider } from "@zcode/ui/i18n";
import { ConversationShareReadonlyTimeline } from "@zcode/ui/conversation-share-readonly";
import { WebLoginPage } from "../auth/index.js";
import type { Gateway } from "./gateway.js";
import { projectThread, str } from "./threadProjection.js";

function PrivateShare({ gateway, id }: { gateway: Gateway; id: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    void gateway
      .request("/api/selfhost/shares", z.record(z.string(), z.unknown()), "POST", {
        operation: "read",
        id,
      })
      .then(setData, (e) => setError(String(e)));
  }, [gateway, id]);
  if (!data)
    return (
      <WebLoginPage
        local={{
          title: "私有分享",
          description: error || "读取中…",
          form: <a href="/">返回工作区</a>,
        }}
      />
    );
  const snapshot = projectThread(
    { history: data.history, thread: { name: data.title } },
    str(data.sessionId),
    id,
    1,
    [],
    new Map(),
  );
  return (
    <main className="mx-auto min-h-dvh max-w-4xl bg-background p-6 text-foreground">
      <h1 className="mb-4 text-ui-xl">{str(data.title)}</h1>
      <ConversationShareReadonlyTimeline rows={snapshot.rows.window} />
    </main>
  );
}

export default function PrivateShareRoute({
  gateway,
  id,
  fallback,
}: {
  gateway: Gateway;
  id: string;
  fallback: ReactNode;
}) {
  return (
    <ZCodeIntlProvider fallback={fallback}>
      <PrivateShare gateway={gateway} id={id} />
    </ZCodeIntlProvider>
  );
}
