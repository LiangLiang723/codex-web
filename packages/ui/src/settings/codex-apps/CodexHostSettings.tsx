import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

type Row = { id: string; label: string; detail?: string; status: string; tools?: number };

export function CodexHostSettings({
  kind,
  workspacePath,
}: {
  kind: "mcp" | "hooks";
  workspacePath: string | undefined;
}) {
  const { hooksService, mcpSyncService } = useBaseWorkspaceServices();
  const { intl } = useZCodeIntl();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ rows: Row[]; diagnostics: string[] }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!workspacePath) return;
    let current = true;
    setError(undefined);
    const read = async () => {
      if (kind === "mcp") {
        const { statuses } = await mcpSyncService.listWorkspaceMcpServerStatuses({ workspacePath });
        return {
          rows: Object.entries(statuses).map(([name, state]) => ({
            id: name,
            label: name,
            detail: state.error,
            status: state.failureKind === "not_authenticated" ? "needsAuth" : state.status,
            tools: state.toolCount,
          })),
          diagnostics: [],
        };
      }
      if (!hooksService.listNativeHooks) throw Error("Codex hook discovery is unavailable.");
      const { hooks, diagnostics } = await hooksService.listNativeHooks({ workspacePath });
      return {
        rows: hooks.map((hook) => ({
          id: hook.key,
          label: hook.eventName,
          detail: hook.sourcePath,
          status: hook.enabled ? "enabled" : "disabled",
        })),
        diagnostics,
      };
    };
    void read().then(
      (value) => {
        if (current) setResult(value);
      },
      (cause) => {
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [hooksService, kind, mcpSyncService, revision, workspacePath]);

  return (
    <section className="space-y-4" data-testid={`selfhost-settings-${kind}`}>
      <div className="flex justify-end">
        <Button variant="outline" onClick={() => setRevision((value) => value + 1)}>
          {intl.formatMessage({ id: "common.refresh" })}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!result && !error ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "common.loading" })}
        </p>
      ) : null}
      {result?.rows.length ? (
        <SettingsGroupCard>
          {result.rows.map((row) => (
            <SettingsRow
              key={row.id}
              label={row.label}
              description={row.detail}
              control={
                <span className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: `selfhost.settings.status.${row.status}` })}
                  {row.tools !== undefined
                    ? ` · ${intl.formatMessage({ id: "settings.mcp.status.toolCount" }, { count: row.tools })}`
                    : ""}
                </span>
              }
            />
          ))}
        </SettingsGroupCard>
      ) : result ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id: kind === "hooks" ? "settings.hooks.empty" : "settings.mcp.emptyTitle",
          })}
        </p>
      ) : null}
      {result?.diagnostics.map((diagnostic, index) => (
        <p key={`${index}/${diagnostic}`} className="break-words text-ui-sm text-foreground-subtle">
          {diagnostic}
        </p>
      ))}
    </section>
  );
}
