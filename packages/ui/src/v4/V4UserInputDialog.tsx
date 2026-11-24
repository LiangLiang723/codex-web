import { useCallback, useState, useMemo, useRef, type FormEvent } from "react";
import {
  TID_V4_USER_INPUT_DIALOG,
  TID_V4_USER_INPUT_OPTION,
  TID_V4_USER_INPUT_TEXT,
  testId,
} from "@zcode/shared/test-ids";
import { z } from "zod";
import type { NativeCodexQuestions, NativeMcpElicitation } from "@zcode/shared/zcode-protocol-v4";
import { Textarea } from "@/components/ui/textarea.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { V4UserInputViewModel } from "@/v4/pendingInteractionAdapter.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

export interface V4UserInputDialogProps {
  model: V4UserInputViewModel;
  onSubmit: (answer: { optionId?: string; freeText?: string }) => void;
}

/** v4 userInput 交互最小弹窗（竖切）。 */
export function V4UserInputDialog({ model, onSubmit }: V4UserInputDialogProps) {
  const { intl } = useZCodeIntl();
  const [freeText, setFreeText] = useState("");

  const handleOption = useCallback(
    (optionId: string) => {
      runUserAction({
        input: {
          featureId: "conversation.blocking.user_input",
          action: "select_option",
          trigger: "button",
        },
        operation: () => onSubmit({ optionId }),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "user_input_submit",
      });
    },
    [onSubmit],
  );

  const handleFreeTextSubmit = useCallback(() => {
    const trimmed = freeText.trim();
    if (!trimmed && model.freeText) return;
    onSubmit(model.freeText ? { freeText: trimmed } : { optionId: model.options[0]?.optionId });
  }, [freeText, model.freeText, model.options, onSubmit]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      data-testid={TID_V4_USER_INPUT_DIALOG}
    >
      <div className="w-full max-w-lg rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-lg">
        <p className="mb-3 text-ui-base text-[var(--color-foreground)]">{model.prompt}</p>
        {model.options.length > 0 ? (
          <div className="mb-3 flex flex-col gap-2">
            {model.options.map((option) => (
              <Button
                key={option.optionId}
                type="button"
                variant="outline"
                data-testid={testId(TID_V4_USER_INPUT_OPTION, option.optionId)}
                onClick={() => handleOption(option.optionId)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : null}
        {model.freeText ? (
          <div className="flex flex-col gap-2">
            <Input
              type={model.sensitive ? "password" : "text"}
              value={freeText}
              onChange={(event) => setFreeText(event.target.value)}
              data-testid={TID_V4_USER_INPUT_TEXT}
            />
            <Button type="button" onClick={handleFreeTextSubmit}>
              {/* 提交按钮跟随界面语言，复用 elicitation 的同义文案 */}
              {intl.formatMessage({ id: "chat.elicitation.submit" })}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 原生问题使用题目 ID 收集答案，秘密字段只保留在当前表单 DOM 内。 */
export function CodexQuestionsForm({
  request,
  respond,
}: {
  request: NativeCodexQuestions;
  respond: (answers: Record<string, string>) => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const inFlight = useRef(false);

  async function send(answers: Record<string, string>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      if (await respond(answers)) return;
    } catch {
      // 保留当前页的回答供重试，快照清场后销毁这个表单。
    }
    inFlight.current = false;
    setBusy(false);
    setFailed(true);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const answers = Object.fromEntries(
      request.questions.flatMap(({ id, options }) => {
        const selection = data.get(`option-${id}`);
        const text = data.get(`answer-${id}`);
        const value =
          selection === "other" || !options?.length
            ? text
            : typeof selection === "string" && selection !== ""
              ? options[Number(selection)]?.label
              : undefined;
        return typeof value === "string" && value.trim() ? [[id, value]] : [];
      }),
    );
    void send(answers);
  }

  return (
    <form
      onSubmit={submit}
      data-testid="codex-user-input"
      className="grid max-h-[65dvh] gap-3 overflow-y-auto rounded-xl border border-card-border bg-card p-4 text-ui-sm text-foreground"
    >
      {request.questions.map(({ id, header, question, options, isOther, isSecret }) => (
        <fieldset key={id} className="grid min-w-0 gap-2" disabled={busy}>
          <legend className="mb-1 text-ui-xs text-foreground-subtle">{header}</legend>
          <p className="break-words font-medium">{question}</p>
          {options?.length ? (
            <select
              className="min-w-0 rounded-md border border-input-border bg-input px-2 py-1.5 max-sm:text-mobile-input-safe"
              name={`option-${id}`}
              aria-label={header || question}
              value={selections[id] ?? ""}
              onChange={(event) =>
                setSelections((prior) => ({ ...prior, [id]: event.target.value }))
              }
            >
              <option value="">—</option>
              {options.map((option, index) => (
                <option key={option.label} value={index}>
                  {option.description ? `${option.label} · ${option.description}` : option.label}
                </option>
              ))}
              {isOther && (
                <option value="other">
                  {intl.formatMessage({ id: "selfhost.question.other" })}
                </option>
              )}
            </select>
          ) : null}
          {!options?.length || (isOther && selections[id] === "other") ? (
            <Input
              name={`answer-${id}`}
              aria-label={header || question}
              autoComplete="off"
              type={isSecret ? "password" : "text"}
              className="max-sm:text-mobile-input-safe"
            />
          ) : null}
        </fieldset>
      ))}
      {failed && (
        <p role="alert" className="text-destructive">
          {intl.formatMessage({ id: "chat.permission.responseFailed" })}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void send({})}
        >
          {intl.formatMessage({ id: "selfhost.question.skip" })}
        </Button>
        <Button size="sm" disabled={busy}>
          {intl.formatMessage({ id: "chat.elicitation.submit" })}
        </Button>
      </div>
    </form>
  );
}

type Schema = Record<string, unknown>;
type Action = "accept" | "decline" | "cancel";
const object = (v: unknown): v is Schema =>
  typeof v === "object" && v !== null && !Array.isArray(v);
function choices(schema: Schema): { value: unknown; label: string }[] | undefined {
  if (Array.isArray(schema.enum))
    return schema.enum.map((value, i) => ({
      value,
      label: String(Array.isArray(schema.enumNames) ? (schema.enumNames[i] ?? value) : value),
    }));
  if (
    Array.isArray(schema.oneOf) &&
    schema.oneOf.every((v) => object(v) && Object.hasOwn(v, "const"))
  )
    return schema.oneOf.map((v) => ({ value: v.const, label: String(v.title ?? v.const) }));
}
function safeLink(raw?: string) {
  try {
    const u = new URL(raw ?? "");
    return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}

// 标准 MCP 标量字段用 ZCode 控件。扩展或嵌套的 JSON 表单保留完整结构和类型。
export function McpElicitationForm({
  request,
  prompt,
  respond,
}: {
  request: NativeMcpElicitation;
  prompt: string;
  respond: (action: Action, value?: unknown) => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const msg = (id: string) => intl.formatMessage({ id });
  const schema = object(request.requestedSchema) ? request.requestedSchema : {};
  const fields = object(schema.properties) ? Object.entries(schema.properties) : [];
  const structured =
    request.mode !== "url" &&
    (schema.type === "object" || object(schema.properties)) &&
    !(
      fields.length === 0 &&
      (schema.additionalProperties === true || object(schema.additionalProperties))
    ) &&
    fields.every(
      ([, v]) =>
        object(v) &&
        (choices(v) || ["string", "integer", "number", "boolean"].includes(String(v.type))),
    ) &&
    !["oneOf", "anyOf", "allOf", "$ref", "if", "patternProperties"].some((k) => k in schema);
  const validator = useMemo(() => {
    if (!object(request.requestedSchema)) return undefined;
    try {
      return z.fromJSONSchema(request.requestedSchema);
    } catch {
      return undefined;
    }
  }, [request.requestedSchema]);
  const url = safeLink(request.url);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const inFlight = useRef(false);
  async function submit(action: Action, value?: unknown) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (await respond(action, value)) return;
      setError(msg("chat.permission.responseFailed"));
    } catch {
      setError(msg("chat.permission.responseFailed"));
    }
    inFlight.current = false;
    setBusy(false);
  }
  function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.mode === "url") {
      if (url) void submit("accept");
      return;
    }
    const data = new FormData(event.currentTarget);
    try {
      let value: unknown;
      if (!structured) {
        value = JSON.parse(String(data.get("json")));
      } else {
        const content: [string, unknown][] = [];
        for (const [name, field] of fields) {
          if (!object(field)) continue;
          const raw = data.get("field-" + name);
          if (raw === null || raw === "") continue;
          const options = choices(field);
          const typed = options
            ? options[Number(raw)]?.value
            : field.type === "boolean"
              ? raw === "true"
              : field.type === "integer" || field.type === "number"
                ? Number(raw)
                : raw;
          content.push([name, typed]);
        }
        value = Object.fromEntries(content);
      }
      if (validator && !validator.safeParse(value).success) throw Error();
      void submit("accept", value);
    } catch {
      setError(msg("selfhost.mcp.invalid"));
    }
  }
  return (
    <form
      onSubmit={accept}
      data-testid="codex-mcp-elicitation"
      className="grid max-h-[65dvh] gap-3 overflow-y-auto rounded-xl border border-card-border bg-card p-4 text-ui-sm text-foreground"
    >
      <div className="text-ui-xs font-medium text-foreground-subtle">
        {msg("selfhost.mcp.title")} · {request.serverName}
      </div>
      <p className="whitespace-pre-wrap break-words font-medium">{prompt}</p>
      {request.mode === "url" ? (
        url ? (
          <a className="break-all underline" href={url} target="_blank" rel="noopener noreferrer">
            {msg("selfhost.mcp.link")} · {new URL(url).host}
          </a>
        ) : (
          <p role="alert">{msg("selfhost.mcp.invalidUrl")}</p>
        )
      ) : structured ? (
        fields.map(([name, field]) => {
          if (!object(field)) return null;
          const required = Array.isArray(schema.required) && schema.required.includes(name);
          const options = choices(field),
            key = "field-" + name;
          const defaultValue = field.default === undefined ? "" : String(field.default);
          return (
            <label key={name} className="grid gap-1">
              <span>{String(field.title ?? name)}</span>
              {options || field.type === "boolean" ? (
                <select
                  className="rounded-md border border-input-border bg-input px-2 py-1.5"
                  name={key}
                  required={required}
                  defaultValue={
                    options
                      ? options.some((o) => o.value === field.default)
                        ? String(options.findIndex((o) => o.value === field.default))
                        : ""
                      : defaultValue
                  }
                >
                  <option value="">—</option>
                  {options ? (
                    options.map((o, i) => (
                      <option key={i} value={i}>
                        {o.label}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </>
                  )}
                </select>
              ) : (
                <Input
                  name={key}
                  required={required}
                  type={field.type === "number" || field.type === "integer" ? "number" : "text"}
                  step={field.type === "integer" ? "1" : "any"}
                  min={typeof field.minimum === "number" ? field.minimum : undefined}
                  max={typeof field.maximum === "number" ? field.maximum : undefined}
                  minLength={typeof field.minLength === "number" ? field.minLength : undefined}
                  maxLength={typeof field.maxLength === "number" ? field.maxLength : undefined}
                  defaultValue={defaultValue}
                />
              )}
              {typeof field.description === "string" && (
                <span className="text-ui-xs text-foreground-subtle">{field.description}</span>
              )}
            </label>
          );
        })
      ) : (
        <label className="grid gap-1">
          {msg("selfhost.mcp.json")}
          <pre className="max-h-36 overflow-auto text-ui-xs">
            {JSON.stringify(request.requestedSchema, null, 2)}
          </pre>
          <Textarea
            required
            name="json"
            defaultValue={
              schema.default === undefined ? "" : JSON.stringify(schema.default, null, 2)
            }
          />
        </label>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => void submit("cancel")}
        >
          {msg("selfhost.cancel")}
        </Button>
        <Button
          size="sm"
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void submit("decline")}
        >
          {msg("selfhost.mcp.decline")}
        </Button>
        <Button size="sm" disabled={busy || (request.mode === "url" && !url)}>
          {msg("selfhost.mcp.submit")}
        </Button>
      </div>
    </form>
  );
}
