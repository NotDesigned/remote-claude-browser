#!/usr/bin/env bash
# Publish already checked bundles over the running server image. No dependency installation or
# source compilation happens on the browser host, and the persistent Chrome data is never replaced.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ ${CLAUDE_LIMITED_TASK:-} != 1 ]]; then
  exec bash scripts/limited-run.sh bash deploy/remote/deploy-container.sh "$@"
fi
if [[ $# != 0 ]]; then
  echo 'usage: deploy-container.sh (REMOTE_HOST and optional REMOTE_SSH_IDENTITY in the environment)' >&2
  exit 2
fi
# Explicit invocation values override saved defaults, including a corrected literal SSH host.
declare -A publish_overrides=()
for publish_setting in REMOTE_HOST REMOTE_SERVER_DIR REMOTE_SSH_IDENTITY REMOTE_SSH_KNOWN_HOSTS DEPLOY_SESSION_CAPACITY; do
  if [[ -v $publish_setting ]]; then publish_overrides[$publish_setting]=${!publish_setting}; fi
done
if [[ -f deploy/remote/local.env ]]; then . deploy/remote/local.env; fi
for publish_setting in "${!publish_overrides[@]}"; do
  printf -v "$publish_setting" '%s' "${publish_overrides[$publish_setting]}"
done
remote_host=${REMOTE_HOST:?Set REMOTE_HOST to the browser server SSH host}
server_dir=${REMOTE_SERVER_DIR:-/opt/claude-browser/docker}
# Empty keeps the server's own MIRROR_CLIENTS; a number replaces it.
session_capacity=${DEPLOY_SESSION_CAPACITY:-}
[[ $remote_host =~ ^[A-Za-z0-9][A-Za-z0-9_.@:-]*$ ]] || exit 2
[[ $server_dir =~ ^/[A-Za-z0-9_./-]+$ && $server_dir != *..* ]] || exit 2
if [[ -n $session_capacity ]]; then
  [[ $session_capacity =~ ^[1-9][0-9]*$ ]] || exit 2
  python3 - "$session_capacity" <<'PY'
import sys
if int(sys.argv[1]) > 9007199254740991:
    raise SystemExit('DEPLOY_SESSION_CAPACITY must be a positive safe integer')
PY
fi

ssh_options=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes)
if [[ -n ${REMOTE_SSH_IDENTITY:-} ]]; then
  # An explicit identity also makes the hostname literal, rather than combining another alias's key.
  ssh_options+=(-F none -i "$REMOTE_SSH_IDENTITY" -o IdentitiesOnly=yes)
fi
if [[ -n ${REMOTE_SSH_KNOWN_HOSTS:-} ]]; then
  ssh_options+=(-o "UserKnownHostsFile=$REMOTE_SSH_KNOWN_HOSTS")
fi
ssh_server() { ssh "${ssh_options[@]}" "$remote_host" "$@"; }

for checked_file in packages/gateway/dist/main.mjs packages/viewer/dist/index.html \
  deploy/server-entrypoint.sh deploy/server-egress.sh deploy/egress-tunnel.sh \
  deploy/egress-proxy.mjs deploy/fetch-sing-box.mjs deploy/timezone.mjs compose.proxy.yml; do
  test -s "$checked_file"
done
stage=$(mktemp -d /tmp/claude-container-publish.XXXXXX)
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/rootfs/app/dist" "$stage/rootfs/app/viewer" \
  "$stage/rootfs/opt/remote-browser" "$stage/rootfs/etc"
install -m 644 packages/gateway/dist/main.mjs "$stage/rootfs/app/dist/main.mjs"
cp -a packages/viewer/dist/. "$stage/rootfs/app/viewer/"
install -m 755 deploy/server-entrypoint.sh deploy/server-egress.sh deploy/egress-tunnel.sh \
  "$stage/rootfs/opt/remote-browser/"
install -m 644 deploy/egress-proxy.mjs deploy/timezone.mjs "$stage/rootfs/opt/remote-browser/"
# sing-box is large, so it goes over only when the running image lacks this very binary.
case $(ssh_server uname -m) in
  x86_64) sing_box_arch=amd64 ;;
  aarch64) sing_box_arch=arm64 ;;
  *) echo 'The browser host is neither x86_64 nor aarch64.' >&2; exit 1 ;;
esac
sing_box_cache=${XDG_CACHE_HOME:-$HOME/.cache}/remote-claude-browser
mkdir -p "$sing_box_cache"
node deploy/fetch-sing-box.mjs "$sing_box_arch" "$stage/sing-box" \
  "$sing_box_cache/sing-box-$sing_box_arch.tar.gz"
mkdir -p "$stage/rootfs/usr/share/doc/sing-box"
install -m 644 "$stage/sing-box/LICENSE" "$stage/rootfs/usr/share/doc/sing-box/LICENSE"
running_sing_box=$(ssh_server "cd '$server_dir' && docker exec \"\$(docker compose ps --quiet server)\" sha256sum /usr/local/bin/sing-box 2>/dev/null" | cut -d' ' -f1 || true)
if [[ $running_sing_box != "$(sha256sum "$stage/sing-box/sing-box" | cut -d' ' -f1)" ]]; then
  mkdir -p "$stage/rootfs/usr/local/bin"
  install -m 755 "$stage/sing-box/sing-box" "$stage/rootfs/usr/local/bin/sing-box"
fi
rm -rf -- "$stage/sing-box"
install -m 644 LICENSE NOTICE THIRD_PARTY_NOTICES.md UPSTREAM_COMMIT "$stage/rootfs/app/"
ln -s /data/timezone/localtime "$stage/rootfs/etc/localtime"
ln -s /data/timezone/name "$stage/rootfs/etc/timezone"
install -m 644 compose.yml compose.hostnet.yml compose.proxy.yml "$stage/"
cat >"$stage/Dockerfile" <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
# Preserve permissions and the localtime symlinks from the prepared archive. This requires no RUN.
COPY rootfs/ /
DOCKERFILE
python3 - "$stage" <<'PY'
from pathlib import Path
import hashlib, sys
root = Path(sys.argv[1])
with (root / 'SHA256SUMS').open('w') as output:
    for path in sorted(root.rglob('*')):
        if path.is_file() and not path.is_symlink() and path.name != 'SHA256SUMS':
            output.write(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + str(path.relative_to(root)) + '\n')
PY
archive=$(mktemp /tmp/claude-container-archive.XXXXXX.tar.gz)
trap 'rm -rf -- "$stage"; rm -f -- "$archive"' EXIT
tar -C "$stage" -czf "$archive" .
archive_digest=$(sha256sum "$archive" | cut -d' ' -f1)
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${archive_digest:0:12}"
remote_stage=$(ssh_server mktemp -d /tmp/claude-container-publish.XXXXXX)
[[ $remote_stage =~ ^/tmp/claude-container-publish\.[A-Za-z0-9]+$ ]] || exit 2
ssh_server "cat > $remote_stage/payload.tar.gz" <"$archive"

ssh_server bash -s -- "$remote_stage" "$archive_digest" "$release_id" "$server_dir" "${session_capacity:--}" <<'REMOTE'
set -euo pipefail
umask 077
stage=$1 expected_digest=$2 release_id=$3 server_dir=$4 capacity=$5
if [[ $capacity = - ]]; then capacity=; fi
exec 9>/run/lock/claude-container-deploy.lock
flock -n 9 || { echo 'Another container deployment is already running.' >&2; exit 1; }
cd "$server_dir"
test -s .env
container=$(docker compose ps --quiet server)
test -n "$container"
previous_image_reference=$(docker inspect "$container" --format '{{.Config.Image}}')
previous_image_id=$(docker inspect "$container" --format '{{.Image}}')
[[ $previous_image_id =~ ^sha256:[0-9a-f]{64}$ ]]
previous_image="remote-claude-browser-server:rollback-$release_id"
project=$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project"}}')
network=$(docker inspect "$container" --format '{{.HostConfig.NetworkMode}}')
volume=$(docker inspect "$container" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')
[[ $volume = /* && $volume != / && -d $volume/profile ]]
release="/opt/claude-browser/container-releases/$release_id"
mkdir -p "$release/payload" "$release/backup"
printf '%s  %s\n' "$expected_digest" "$stage/payload.tar.gz" | sha256sum --check --status
tar -xzf "$stage/payload.tar.gz" -C "$release/payload"
(cd "$release/payload" && sha256sum --check --status SHA256SUMS)
printf '%s\n' "$previous_image" >"$release/backup/image"
printf '%s\n' "$previous_image_id" >"$release/backup/image-id"
printf '%s\n' "$previous_image_reference" >"$release/backup/image-reference"
printf '%s\n' "$project" >"$release/backup/project"
printf '%s\n' "$volume" >"$release/backup/volume"
cp -a .env compose.yml "$release/backup/"
if [[ -f compose.hostnet.yml ]]; then cp -a compose.hostnet.yml "$release/backup/"; fi
if [[ -f compose.proxy.yml ]]; then cp -a compose.proxy.yml "$release/backup/"; fi

# The current runtime already supplies these; fail before touching a live browser if it does not.
docker exec "$container" node -e 'if(typeof require("node:sqlite").DatabaseSync!=="function") process.exit(1)'
docker exec "$container" test -s /usr/share/zoneinfo/Etc/UTC
docker exec "$container" node -e 'if(process.env.CHROME_USER_DATA_DIR!=="/data/profile" || (process.env.MIRROR_USERS_DB && process.env.MIRROR_USERS_DB!=="/data/profile/users.sqlite") || (process.env.MIRROR_ACCOUNTS_DIR && process.env.MIRROR_ACCOUNTS_DIR!=="/data/profile-accounts")) {console.error("This deployment script requires the standard /data/profile layout"); process.exit(1)}'
# Bind a release-specific reference to the running container's immutable image, even if its old
# configured tag has since moved. Both the COPY-only build and rollback use this exact base.
docker image tag "$previous_image_id" "$previous_image"
image="remote-claude-browser-server:$release_id"
DOCKER_BUILDKIT=0 docker build --quiet --network none --memory=128m --memory-swap=192m \
  --cpu-period=100000 --cpu-quota=20000 --build-arg "BASE_IMAGE=$previous_image" \
  --label "org.opencontainers.image.version=$release_id" --tag "$image" "$release/payload" >/dev/null
# A tiny process checks the image without running Xvfb, a gateway or another Chrome.
docker run --rm --network none --read-only --memory=64m --memory-swap=64m --pids-limit=32 \
  --entrypoint sh "$image" -c \
  'test "$(readlink /etc/localtime)" = /data/timezone/localtime && test "$(readlink /etc/timezone)" = /data/timezone/name && test -x /opt/remote-browser/server-entrypoint.sh && test -x /opt/remote-browser/egress-tunnel.sh && node --check /opt/remote-browser/timezone.mjs && node --check /opt/remote-browser/egress-proxy.mjs && sing-box version >/dev/null'
echo "Prepared checked image: $image"

compose=(docker compose --project-name "$project" --project-directory "$server_dir" --env-file "$server_dir/.env" -f "$server_dir/compose.yml")
if [[ $network = host ]]; then compose+=(-f "$server_dir/compose.hostnet.yml"); fi
# An outside proxy named in .env brings its overlay along.
proxied=0
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?EGRESS_PROXY[[:space:]]*=[[:space:]]*[^[:space:]#]' .env; then
  proxied=1
  compose+=(-f "$server_dir/compose.proxy.yml")
fi
activated=0
metadata_ready=0
finished=0
stop_before_metadata_restore() {
  local ids id state
  "${compose[@]}" stop server >>"$release/rollback.log" 2>&1 || true
  if ! ids=$(docker ps --all --quiet \
      --filter "label=com.docker.compose.project=$project" \
      --filter 'label=com.docker.compose.service=server'); then
    echo 'Could not verify the server containers are stopped.' >&2
    return 1
  fi
  while IFS= read -r id; do
    [[ -n $id ]] || continue
    if ! state=$(docker inspect "$id" --format '{{.State.Status}}'); then return 1; fi
    case $state in
      created|exited|dead) continue ;;
    esac
    docker stop --time 25 "$id" >>"$release/rollback.log" 2>&1 || true
    if ! state=$(docker inspect "$id" --format '{{.State.Status}}'); then return 1; fi
    case $state in
      created|exited|dead) continue ;;
    esac
    docker kill "$id" >>"$release/rollback.log" 2>&1 || true
    if ! state=$(docker inspect "$id" --format '{{.State.Status}}'); then return 1; fi
    case $state in
      created|exited|dead) ;;
      *) echo "Server container $id is still $state; management metadata will not be restored." >&2; return 1 ;;
    esac
  done <<<"$ids"
}
rollback() {
  local result=$?
  if [[ $finished = 1 || $activated = 0 ]]; then return "$result"; fi
  set +e
  echo 'Deployment failed; restoring the previous image and management metadata.' >&2
  if ! stop_before_metadata_restore; then
    echo "Rollback could not safely stop the server. Metadata is unchanged; recovery files: $release" >&2
    return "$result"
  fi
  if ! cp -a "$release/backup/.env" "$server_dir/.env" || ! cp -a "$release/backup/compose.yml" "$server_dir/compose.yml"; then
    echo "Could not restore deployment configuration. Recovery files: $release" >&2
    return "$result"
  fi
  if [[ -f $release/backup/compose.hostnet.yml ]] && ! cp -a "$release/backup/compose.hostnet.yml" "$server_dir/compose.hostnet.yml"; then
    echo "Could not restore network configuration. Recovery files: $release" >&2
    return "$result"
  fi
  if [[ -f $release/backup/compose.proxy.yml ]]; then
    if ! cp -a "$release/backup/compose.proxy.yml" "$server_dir/compose.proxy.yml"; then
      echo "Could not restore proxy configuration. Recovery files: $release" >&2
      return "$result"
    fi
  elif [[ $proxied = 1 ]]; then
    # The previous runtime predates the proxy and cannot start with it.
    compose=("${compose[@]:0:${#compose[@]}-2}")
  fi
  if [[ $metadata_ready = 1 ]]; then
    if ! python3 - "$volume" <<'PY'
from pathlib import Path
import shutil, sys
root = Path(sys.argv[1])
for relative in ['profile/client-sessions.json', 'profile/accounts.json', 'profile/asset-token.key',
                 'profile/users.sqlite', 'profile/users.sqlite-wal', 'profile/users.sqlite-shm',
                 'profile/users.sqlite-journal', 'timezone']:
    path = root / relative
    if path.is_dir() and not path.is_symlink(): shutil.rmtree(path)
    else: path.unlink(missing_ok=True)
PY
    then
      echo "Could not prepare metadata recovery. The server remains stopped; recovery files: $release" >&2
      return "$result"
    fi
    if ! tar -xpf "$release/backup/metadata.tar" -C "$volume"; then
      echo "Could not restore management metadata. The server remains stopped; recovery files: $release" >&2
      return "$result"
    fi
  fi
  if SERVER_IMAGE="$previous_image" "${compose[@]}" up --detach --no-build server >>"$release/rollback.log" 2>&1; then
    echo "Previous runtime restored; protected deployment files: $release" >&2
  else
    echo "The previous runtime did not start. Recovery files: $release" >&2
  fi
  return "$result"
}
trap rollback EXIT
activated=1
echo 'Restarting the browser service; open remote pages and unsent drafts will be interrupted.'
"${compose[@]}" stop server >/dev/null
# Chrome is stopped before backing up SQLite/WAL or changing ownership metadata.
python3 - "$volume" "$release/backup/metadata.files" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
paths = ['profile/client-sessions.json', 'profile/accounts.json', 'profile/asset-token.key',
         'profile/users.sqlite', 'profile/users.sqlite-wal', 'profile/users.sqlite-shm',
         'profile/users.sqlite-journal', 'timezone']
Path(sys.argv[2]).write_bytes(b''.join(path.encode() + b'\0' for path in paths if (root/path).exists()))
PY
tar -cpf "$release/backup/metadata.tar" --numeric-owner -C "$volume" --null -T "$release/backup/metadata.files"
metadata_ready=1
install -m 644 "$release/payload/compose.yml" "$server_dir/compose.yml"
install -m 644 "$release/payload/compose.hostnet.yml" "$server_dir/compose.hostnet.yml"
install -m 644 "$release/payload/compose.proxy.yml" "$server_dir/compose.proxy.yml"
python3 - "$server_dir/.env" "$image" "$capacity" <<'PY'
from pathlib import Path
import os, re, sys
file = Path(sys.argv[1])
# Only the image always changes. TZ stays the operator's; capacity changes only when one was given.
values = {'SERVER_IMAGE': sys.argv[2]}
if sys.argv[3]: values['MIRROR_CLIENTS'] = sys.argv[3]
lines = []
for line in file.read_text().splitlines():
    match = re.match(r'\s*(?:export\s+)?([A-Z0-9_]+)\s*=', line)
    if match and match.group(1) in values: continue
    lines.append(line)
lines.extend(key+'='+value for key,value in values.items())
temporary = file.with_suffix('.env.next')
temporary.write_text('\n'.join(lines)+'\n')
temporary.chmod(0o600)
os.replace(temporary, file)
PY
"${compose[@]}" config --quiet
"${compose[@]}" up --detach --no-build server >"$release/startup.log" 2>&1
port=$(docker inspect "$("${compose[@]}" ps --quiet server)" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^GATEWAY_PORT=//p' | head -1)
port=${port:-3010}
[[ $port =~ ^[0-9]+$ ]]
for attempt in $(seq 1 45); do
  health=$(curl --fail --silent --max-time 3 "http://127.0.0.1:$port/healthz" 2>/dev/null || true)
  if CLAUDE_HEALTH_JSON="$health" python3 - "$capacity" <<'PY'
import json, os, sys
try: value=json.loads(os.environ.get('CLAUDE_HEALTH_JSON',''))
except Exception: sys.exit(1)
capacity_ok = not sys.argv[1] or value.get('maxClients') == int(sys.argv[1])
sys.exit(0 if value.get('ok') is True and value.get('browser') is True and capacity_ok else 1)
PY
  then
    active=$("${compose[@]}" ps --quiet server)
    gate=$(curl --fail --silent --max-time 3 "http://127.0.0.1:$port/gate" 2>/dev/null || true)
    [[ $gate == *'name="username"'* ]]
    resolved_timezone=$(docker exec "$active" cat /data/timezone/name)
    timezone_offset=$(docker exec "$active" date +%z)
    expected_offset=$(docker exec --env "TZ=$resolved_timezone" "$active" date +%z)
    [[ $timezone_offset = "$expected_offset" ]]
    printf '%s\n' "$resolved_timezone"
    docker exec "$active" sha256sum /app/dist/main.mjs
    if [[ $proxied = 1 ]]; then
      docker logs "$active" 2>&1 | grep 'Browser traffic leaves through' | tail -1
      # As the browser user, so through the tunnel. The proxy is outside this host and may be down,
      # which leaves pages offline but is no reason to undo the deployment.
      exit_ip=$(docker exec --user browser "$active" node -e 'fetch("https://api.ipify.org",{signal:AbortSignal.timeout(10000)}).then(r=>r.text()).then(t=>console.log(t.trim())).catch(()=>process.exit(1))' 2>/dev/null || true)
      if [[ -n $exit_ip ]]; then echo "Pages leave from $exit_ip"; else echo 'Warning: pages cannot reach the internet through the outside proxy yet.' >&2; fi
    fi
    printf '%s\n' "$image" >"$release/image"
    ln -sfn "$release" /opt/claude-browser/container-current
    finished=1
    rm -rf -- "$stage"
    echo "Container healthy: $image${capacity:+; session capacity=$capacity}"
    exit 0
  fi
  sleep 2
done
echo 'The new container did not pass health checks.' >&2
exit 1
REMOTE
