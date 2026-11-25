import { ZCodeAppLogo } from "@zcode/ui/app-logo";

/** 连接前各页的页头品牌：Codex Web 的标识与名称。 */
export function WebRemoteControlBrand({ className }: { className?: string }) {
  return (
    <span className={["inline-flex items-center gap-2", className].filter(Boolean).join(" ")}>
      <ZCodeAppLogo className="size-5" />
      <span className="text-ui-xs font-medium">Codex Web</span>
    </span>
  );
}
