import * as React from "react";
import { Avatar as AvatarPrimitive } from "radix-ui";

import { cn } from "../lib/utils.js";

function Avatar({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  size?: "default" | "sm" | "lg";
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        "group/avatar relative flex size-8 shrink-0 rounded-full select-none after:absolute after:inset-0 after:rounded-full after:border after:border-border after:mix-blend-darken data-[size=lg]:size-10 data-[size=sm]:size-6 dark:after:mix-blend-lighten",
        className,
      )}
      {...props}
    />
  );
}

function AvatarImage({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full rounded-full object-cover", className)}
      {...props}
    />
  );
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-muted text-ui-base text-muted-foreground group-data-[size=sm]/avatar:text-ui-base",
        className,
      )}
      {...props}
    />
  );
}

function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground bg-blend-color ring-2 ring-background select-none",
        "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
        "group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
        "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
        className,
      )}
      {...props}
    />
  );
}

function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background",
        className,
      )}
      {...props}
    />
  );
}

function AvatarGroupCount({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-ui-base/relaxed text-muted-foreground ring-2 ring-background group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 [&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3",
        className,
      )}
      {...props}
    />
  );
}

export { Avatar, AvatarImage, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarBadge };

export const legacyWorkspaceIcons: Readonly<Record<string, string>> = {
  server: "fas fa-server",
  terminal: "fas fa-terminal",
  cloud: "fas fa-cloud",
  code: "fas fa-code",
  cpu: "fas fa-microchip",
  laptop: "fas fa-laptop",
  monitor: "fas fa-desktop",
  smartphone: "fas fa-mobile-screen",
  database: "fas fa-database",
  drive: "fas fa-hard-drive",
  network: "fas fa-network-wired",
  router: "fas fa-wifi",
  radio: "fas fa-tower-broadcast",
  globe: "fas fa-globe",
  home: "fas fa-house",
  folder: "fas fa-folder-tree",
  file: "fas fa-file-code",
  braces: "fas fa-code-branch",
  container: "fab fa-docker",
  package: "fas fa-box-open",
  layers: "fas fa-layer-group",
  box: "fas fa-cube",
  archive: "fas fa-box-archive",
  shield: "fas fa-shield-halved",
  lock: "fas fa-lock",
  key: "fas fa-key",
  board: "fas fa-memory",
  wrench: "fas fa-wrench",
  bug: "fas fa-bug",
  lightning: "fas fa-bolt",
  camera: "fas fa-camera",
  gamepad: "fas fa-gamepad",
};
const defaultWorkspaceIcon = "fas fa-server";
const workspaceIconClass = /^(?:fas|far|fab) fa-[a-z0-9-]{1,64}$/;
const workspaceIconSizes = {
  sm: "size-6 text-sm",
  default: "size-8 text-base",
  lg: "size-10 text-xl",
};

export function parseWorkspaceAvatar(value: string) {
  const [name = "server", color] = value.split(":", 2);
  const legacy = Object.hasOwn(legacyWorkspaceIcons, name) ? legacyWorkspaceIcons[name] : undefined;
  return {
    image: value.startsWith("data:image/png;base64,") ? value : undefined,
    icon: legacy ?? (workspaceIconClass.test(name) ? name : defaultWorkspaceIcon),
    color: color && /^#[a-f0-9]{6}$/i.test(color) ? color.toLowerCase() : undefined,
  };
}

export function WorkspaceAvatar({
  value = "server",
  size = "default",
  fallback,
}: {
  value?: string;
  size?: "sm" | "default" | "lg";
  fallback?: string;
}) {
  const { image, icon, color } = parseWorkspaceAvatar(value);
  const iconMarkup = (
    <i className={cn(icon, "fa-fw leading-none")} style={color ? { color } : undefined} />
  );
  if (!image && !fallback) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex shrink-0 items-center justify-center text-foreground",
          workspaceIconSizes[size],
        )}
        data-workspace-avatar={icon.slice(7)}
        data-workspace-avatar-color={color}
      >
        {iconMarkup}
      </span>
    );
  }
  return (
    <Avatar size={size} aria-hidden="true" data-workspace-avatar={image ? "image" : undefined}>
      {image && <AvatarImage src={image} alt="" />}
      <AvatarFallback className="bg-surface text-foreground">
        {fallback ?? iconMarkup}
      </AvatarFallback>
    </Avatar>
  );
}
