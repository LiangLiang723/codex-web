import type { PermissionRequestPayload } from "@zcode/shared/zcode-protocol-v4";
import { z } from "zod";

export const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";

const execPolicyPrefixSchema = z.tuple([z.string().min(1)]).rest(z.string());
const prefixDecisionSchema = z.strictObject({
  acceptWithExecpolicyAmendment: z.strictObject({ execpolicy_amendment: execPolicyPrefixSchema }),
});
const networkDecisionSchema = z.strictObject({
  applyNetworkPolicyAmendment: z.strictObject({
    network_policy_amendment: z.strictObject({
      host: z.string().min(1),
      action: z.enum(["allow", "deny"]),
    }),
  }),
});
const simpleDecisions = {
  accept: { kind: "allowOnce", label: "允许本轮" },
  acceptForSession: { kind: "allowAlways", label: "Allow for this session" },
  decline: { kind: "deny", label: "拒绝" },
  cancel: { kind: "deny", label: "Cancel turn" },
} as const;

type SimpleDecision = keyof typeof simpleDecisions;
type ApprovalOption = PermissionRequestPayload["options"][number];
type NativeDecision =
  | SimpleDecision
  | z.infer<typeof prefixDecisionSchema>
  | z.infer<typeof networkDecisionSchema>;

function isSimpleDecision(value: unknown): value is SimpleDecision {
  return typeof value === "string" && Object.hasOwn(simpleDecisions, value);
}

function nativeDecisions(params: Record<string, unknown>): unknown[] {
  // Codex 的显式列表可能刻意禁止持久授权。只有旧版省略列表时才读取独立的前缀提案。
  if (params.availableDecisions != null) {
    return Array.isArray(params.availableDecisions) ? params.availableDecisions : [];
  }
  const prefix = execPolicyPrefixSchema.safeParse(params.proposedExecpolicyAmendment);
  if (
    prefix.success &&
    (params.kind == null || params.kind === "command") &&
    params.networkApprovalContext == null &&
    params.additionalPermissions == null
  ) {
    return [
      "accept",
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix.data } },
      "decline",
    ];
  }
  return ["accept", "decline"];
}

export function commandApprovalChoices(
  params: Record<string, unknown>,
): Array<{ option: ApprovalOption; decision: NativeDecision }> {
  return nativeDecisions(params).flatMap<{ option: ApprovalOption; decision: NativeDecision }>(
    (value, index) => {
      if (isSimpleDecision(value)) {
        if (params.kind === "humanCommand" && value === "acceptForSession") return [];
        const { kind, label } = simpleDecisions[value];
        return [
          {
            option: {
              optionId: value,
              kind,
              label,
              response: { decision: kind === "deny" ? "deny" : "allow" },
            },
            decision: value,
          },
        ];
      }
      if (params.kind === "humanCommand") return [];
      const networkRule = networkDecisionSchema.safeParse(value);
      if (params.networkApprovalContext != null && networkRule.success) {
        const { action, host } =
          networkRule.data.applyNetworkPolicyAmendment.network_policy_amendment;
        return [
          {
            option: {
              optionId: `applyNetworkPolicyAmendment:${index}`,
              kind: action === "allow" ? "allowAlways" : "deny",
              label: action === "allow" ? "Save allow rule" : "Save deny rule",
              description: host,
              response: { decision: action },
            },
            decision: networkRule.data,
          },
        ];
      }
      const amendment = prefixDecisionSchema.safeParse(value);
      if (!amendment.success) return [];
      return [
        {
          option: {
            optionId: `acceptWithExecpolicyAmendment:${index}`,
            kind: "allowAlways",
            label: "Allow similar commands",
            description: JSON.stringify(
              amendment.data.acceptWithExecpolicyAmendment.execpolicy_amendment,
            ),
            response: { decision: "allow" },
          },
          decision: amendment.data,
        },
      ];
    },
  );
}
