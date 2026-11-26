import { BotAvatar } from "@/brand/index.js";
import type { ZCodeAppLogoProps } from "@/components/mobile-ui/contract.js";

export function ZCodeAppLogo({ className, animated }: ZCodeAppLogoProps) {
  return <BotAvatar data-app-logo="zcode" className={className} animated={animated} />;
}
