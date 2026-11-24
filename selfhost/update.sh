#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

# 同一 Docker daemon 上的独立实例可以将各自的发布、保护和清理限制在一个镜像仓库。
repo=${CODEX_WEB_RELEASE_REPOSITORY:-zcode-selfhost}
case "$repo" in ''|*[!a-z0-9._/-]*) echo '无效的发布镜像仓库' >&2; exit 2 ;; esac
mode=${1:---build}
previous=${2:-}
case "$mode:$#:$previous" in
  --build:0:|--build:1:|--no-build:1:|--stage:1:|--cleanup:1:|--cleanup:2:"$repo":*) ;;
  *) printf '%s\n' '用法为 sh selfhost/update.sh [--build | --no-build | --stage | --cleanup [zcode-selfhost:上一版]]' >&2; exit 2 ;;
esac

mkdir -p .selfhost
lock=.selfhost/update.lock
if ! mkdir "$lock"; then
  printf '%s\n' '此工作目录已有更新或清理操作。' >&2
  exit 1
fi
trap 'rmdir "$lock"' EXIT
trap 'exit 1' HUP INT TERM

service_image() {
  container=$(docker compose ps -q codex-web) || return
  if [ -n "$container" ]; then
    docker container inspect --format '{{.State.Health.Status}} {{.Image}} {{.Config.Image}}' "$container"
  fi
}

previous_id=
receipt=.selfhost/update-previous
guard=$repo:pending-rollback
if [ -s "$receipt" ]; then
  IFS= read -r previous_id < "$receipt"
  # 容器可能已被第一次失败的更新替换；重试必须使用替换前保留下来的同一镜像。
  protected=$(docker image inspect --format '{{.Id}}' "$guard")
  [ "$protected" = "$previous_id" ] || { echo '回滚镜像与更新记录不符' >&2; exit 1; }
fi
if [ "$mode" = --cleanup ]; then
  if [ -n "$previous" ]; then
    specified=$(docker image inspect --format '{{.Id}}' "$previous")
    [ -z "$previous_id" ] || [ "$previous_id" = "$specified" ] || exit 1
    previous_id=$specified
  fi
else
  before=$(service_image)
  if [ -z "$previous_id" ]; then
    case "$before" in
    'healthy '*\ "$repo":*)
      previous_id=${before#healthy }
      previous_id=${previous_id%% *}
      docker image tag "$previous_id" "$guard"
      printf '%s\n' "$previous_id" > "$receipt.tmp"
      mv "$receipt.tmp" "$receipt"
      ;;
    esac
  fi
  compose_mode=$mode
  if [ "$mode" = --stage ]; then compose_mode=--no-build; fi
  docker compose up -d "$compose_mode" --wait --wait-timeout 120 codex-web
fi

current=$(service_image)
case "$current" in
  'healthy '*) ;;
  *) printf '%s\n' 'codex-web 尚未通过健康检查。' >&2; exit 1 ;;
esac
active_id=${current#healthy }
active_ref=${active_id#* }
active_id=${active_id%% *}
if [ "$mode" = --stage ]; then exit 0; fi
case "$active_ref" in
  "$repo":*) ;;
  *) exit 0 ;;
esac

rollback=$repo:rollback
old_rollback=$(docker image inspect --format '{{.Id}}' "$rollback" 2>/dev/null || :)
rollback_id=$old_rollback
if [ -n "$previous_id" ] && [ "$previous_id" != "$active_id" ]; then
  docker image tag "$previous_id" "$rollback"
  rollback_id=$previous_id
fi

# 停止的容器也需要镜像。按 ID 保护引用，避免清掉同一镜像的另一个标签。
container_ids=$(docker container ls --all --quiet)
used_ids=$active_id
if [ -n "$container_ids" ]; then
  used_ids=$(docker container inspect --format '{{.Image}}' $container_ids)
fi
is_retained() {
  [ "$1" = "$active_id" ] || [ "$1" = "$rollback_id" ] ||
    printf '%s\n' "$used_ids" | grep -Fxq "$1"
}

images=$(TZ=UTC docker image ls --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedAt}}' "$repo")
active_time=$(printf '%s\n' "$images" | awk -v id="$active_id" '$2 == id { print $3 " " $4; exit }')
if [ -z "$active_time" ]; then
  printf '%s\n' '当前运行的镜像标签已变动，无法确认哪些版本可清理。' >&2
  exit 1
fi
printf '%s\n' "$images" | while read -r ref id date time _; do
  case "$ref" in
    "$repo":*)
      if ! is_retained "$id" && LC_ALL=C awk -v candidate="$date $time" -v active="$active_time" \
        'BEGIN { exit !(candidate < active) }'; then
        docker image rm --no-prune "$ref"
      fi
      ;;
  esac
done

# 覆写回滚标签后，旧回滚镜像可能已无标签。确认没有其他仓库引用才按 ID 删除。
if [ -n "$old_rollback" ] && ! is_retained "$old_rollback" &&
  references=$(docker image inspect --format '{{len .RepoTags}} {{len .RepoDigests}}' "$old_rollback" 2>/dev/null) &&
  [ "$references" = '0 0' ]; then
  docker image rm --no-prune "$old_rollback"
fi
if [ -s "$receipt" ]; then
  rm -f "$receipt"
  docker image rm --no-prune "$guard"
fi
