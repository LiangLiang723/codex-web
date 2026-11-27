import type { IZCodeAgentService } from "@zcode/services";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  const services = useWorkspaceServices(workspacePath, preferredRemoteSessionId, workspaceIdentity, undefined, {
    contextWhenUnscoped: true,
  });
  return services.zcodeAgentService;
}
