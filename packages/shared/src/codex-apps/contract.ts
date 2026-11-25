import { z } from "zod";

// 这是自托管设置页的展示合同。原生响应的较新字段由 Gateway 选择性读取。
const text = z.string().nullable();
export const codexAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: text,
  installUrl: text,
  iconUrl: text.optional(),
  accessible: z.boolean().nullable(),
  enabled: z.boolean().nullable(),
  installed: z.boolean().nullable(),
  callable: z.boolean().nullable(),
  plugins: z.array(z.string()),
});
export const codexAppsListSchema = z.object({
  apps: z.array(codexAppSchema),
  nextCursor: text.default(null),
  runtimeKnown: z.boolean().default(false),
  emptyReason: z.enum(["chatgpt", "disabled"]).nullable().optional(),
  directoryIssue: text,
  runtimeIssue: text,
});
export const codexAppDetailsSchema = z.object({
  configIssue: text.optional(),
  name: text.optional(),
  description: text.optional(),
  iconUrl: text.optional(),
  accessible: z.boolean().nullable().optional(),
  plugins: z.array(z.string()),
  installUrl: text,
  tools: z
    .array(
      z.object({
        name: z.string(),
        title: text,
        description: text,
        enabled: z.boolean().nullable(),
        configurable: z.boolean().optional(),
        readOnly: z.boolean().nullable(),
        disabledReason: text,
      }),
    )
    .nullable(),
});
export const codexAppWriteResultSchema = z.object({ overridden: z.boolean(), message: text });
export type CodexApp = z.infer<typeof codexAppSchema>;
export type CodexAppsList = z.infer<typeof codexAppsListSchema>;
export type CodexAppDetails = z.infer<typeof codexAppDetailsSchema>;
export type CodexAppWriteResult = z.infer<typeof codexAppWriteResultSchema>;

export interface ICodexAppsService {
  list(force: boolean, cursor?: string): Promise<CodexAppsList>;
  listInstalled(force: boolean): Promise<CodexAppsList>;
  listForComposer(threadId?: string): Promise<CodexApp[]>;
  detail(id: string): Promise<CodexAppDetails>;
  setEnabled(id: string, enabled: boolean, tool?: string): Promise<CodexAppWriteResult>;
}
