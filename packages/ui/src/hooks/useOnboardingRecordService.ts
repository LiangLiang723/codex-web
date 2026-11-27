import { useOptionalServices } from "./useServices.js";

/**
 * Onboarding 完成记录服务（本地持久化，后续上传服务器）。
 * 旧测试 double / 不支持的 host 未注册该服务时返回 null，调用方需判空降级。
 * 无 ServiceProvider 的纯渲染测试也通过可选上下文返回 null。
 */
export function useOnboardingRecordService() {
  return useOptionalServices()?.onboardingRecordService ?? null;
}
