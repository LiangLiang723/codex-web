import type { IZCodeSessionService } from "@zcode/services";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  const services = useWorkspaceServices(workspacePath, preferredRemoteSessionId, workspaceIdentity, undefined, {
    contextWhenUnscoped: true,
  });
  return services.zcodeSessionService;
}
