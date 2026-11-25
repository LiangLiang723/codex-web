"use client";

import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { BotAvatar, useBotActivity } from "@/brand/index.js";
import { cn } from "@/components/lib/utils.js";
import { formatRunningWorkDuration } from "@/lib/workDuration.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface ChatLoadingProps extends ComponentPropsWithoutRef<"div"> {
  loading: boolean;
  initialElapsedMs?: number;
  size?: "default" | "sm";
}

export function ChatLoading({
  loading,
  initialElapsedMs = 0,
  className,
  size: _size,
  ...props
}: ChatLoadingProps) {
  const { intl, locale } = useZCodeIntl();
  const activity = useBotActivity();
  const [elapsedMs, setElapsedMs] = useState(initialElapsedMs);
  const baselineRef = useRef<{ elapsedMs: number; startedAt: number } | null>(null);
  useEffect(() => {
    if (!loading) {
      baselineRef.current = null;
      return;
    }
    const now = performance.now();
    const previous = baselineRef.current;
    baselineRef.current = {
      elapsedMs: Math.max(
        initialElapsedMs,
        previous ? previous.elapsedMs + now - previous.startedAt : 0,
      ),
      startedAt: now,
    };
  }, [loading, initialElapsedMs]);
  useEffect(() => {
    if (!loading) return;
    // 上游耗时频繁变化曾反复取消计时器，导致回调饿死；校准基准与刷新生命周期分离。
    const tick = () => {
      const baseline = baselineRef.current;
      if (baseline) setElapsedMs(baseline.elapsedMs + performance.now() - baseline.startedAt);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [loading]);
  if (!loading) return null;
  return (
    <div
      role="status"
      aria-label={intl.formatMessage({ id: "common.loading" })}
      data-zcode-chat-loading-animate="true"
      {...props}
      className={cn("inline-flex w-fit items-center gap-2", className)}
    >
      {/* 原生形变会跨过旧的放大视口。工作与思考使用同尺寸的完整画布。 */}
      <span data-chat-loading-icon className="flex size-5 shrink-0 items-center justify-center">
        <BotAvatar
          className="size-5"
          mood="working"
          animated
          renderSize={20}
          motion={activity && activity.activity !== "idle" ? activity.motion : "working"}
        />
      </span>
      <span className="animated-gradient-text animated-gradient-text-foreground text-ui-base font-normal motion-reduce:animate-none!">
        {intl.formatMessage({ id: "chat.loading.working" })}
      </span>
      <span
        aria-hidden="true"
        className="font-mono text-ui-caption tabular-nums text-foreground-subtle"
      >
        {formatRunningWorkDuration(
          elapsedMs,
          (descriptor) => intl.formatMessage(descriptor),
          locale,
        )}
      </span>
    </div>
  );
}
