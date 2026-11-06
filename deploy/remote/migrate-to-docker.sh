#!/bin/bash
# Moves a two-machine systemd deployment to Docker. Run it on the entry host, one step at a time:
#
#   prepare   Installs Docker on the server and readies the image. Nothing stops.
#   cutover   Stops the systemd browser, copies its profile into the Docker volume and starts the
#             container, going back by itself if it does not come up healthy. Open pages are cut off.
#   tunnel    Replaces this host's systemd tunnel with the container. The reverse proxy stays as it is.
#   rollback  Goes back to systemd on both machines. The original profile is never changed, so what
#             happened in the container since the cutover, such as new site logins, is left behind.
#
# Secrets are moved from the server's agent.env into its .env, and never leave the server.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ -f deploy/remote/local.env ]; then . deploy/remote/local.env; fi
remote_host=${REMOTE_HOST:?Set REMOTE_HOST to the server\'s SSH host, here or in deploy/remote/local.env}
repo_url=${REPO_URL:?Set REPO_URL to this repository\'s public clone URL}
server_image=${SERVER_IMAGE:?Set SERVER_IMAGE to the published server image}
tunnel_image=${TUNNEL_IMAGE:?Set TUNNEL_IMAGE to the published tunnel image}
server_dir=/opt/claude-browser/docker
old_profile=/var/lib/claude-browser/profile
ssh_config_host=$(ssh -G "$remote_host" | awk '$1 == "hostname" { print $2 }')
ssh_config_port=$(ssh -G "$remote_host" | awk '$1 == "port" { print $2 }')
ssh_config_user=$(ssh -G "$remote_host" | awk '$1 == "user" { print $2 }')
ssh_config_key=$(ssh -G "$remote_host" | awk '$1 == "identityfile" { print $2; exit }')
ssh_config_key=${ssh_config_key/#\~/$HOME}

prepare() {
  ssh "$remote_host" bash -s -- "$repo_url" "$server_image" "$server_dir" <<'REMOTE'
set -euo pipefail
repo_url=$1 server_image=$2 server_dir=$3
if ! command -v docker >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends docker.io docker-compose-v2
fi
systemctl enable --now docker
if [ -d "$server_dir/.git" ]; then git -C "$server_dir" pull --ff-only --quiet
else git clone --quiet "$repo_url" "$server_dir"; fi
cd "$server_dir"
if [ ! -f .env ]; then
  value() { sed -n "s/^$1=//p" /etc/claude-browser/agent.env | head -1; }
  own_ips=$(ip -o -4 addr show scope global | awk '{ print $4 }' | cut -d/ -f1 | paste -sd,)
  umask 077
  {
    printf 'MIRROR_ACCESS_PASSWORD=%s\n' "$(value MIRROR_ACCESS_PASSWORD)"
    printf 'MIRROR_ACCESS_SECRET=%s\n' "$(value MIRROR_ACCESS_SECRET)"
    printf 'MIRROR_AUTH_SECRET=%s\n' "$(value MIRROR_AUTH_SECRET)"
    printf 'MIRROR_PUBLIC_ORIGIN=%s\n' "$(value MIRROR_PUBLIC_ORIGIN)"
    printf 'EGRESS_BLOCK=%s\n' "$own_ips${own_ips:+,}$(value GATEWAY_A_IP)"
    printf 'SERVER_IMAGE=%s\n' "$server_image"
    printf 'SERVER_BIND=127.0.0.1\nSERVER_PORT=3010\nMIRROR_CLIENTS=16\n'
    printf 'SERVER_MEMORY=3584m\nSERVER_MEMSWAP=3712m\nSERVER_CPUS=3.8\n'
  } >.env
fi
# Compose reads this itself, so every later command on this host gets the host network.
grep -q '^COMPOSE_FILE=' .env || printf 'COMPOSE_FILE=compose.yml:compose.hostnet.yml\n' >>.env
docker pull --quiet "$server_image"
echo "The image is ready, and the systemd browser is still running."
REMOTE
}

cutover() {
  ssh "$remote_host" bash -s -- "$server_dir" "$old_profile" "$server_image" <<'REMOTE'
set -euo pipefail
server_dir=$1 old_profile=$2 image=$3
cd "$server_dir"
back_to_systemd() {
  docker compose down || true
  systemctl enable --now claude-egress claude-display claude-browser
}
healthy() {
  for _ in $(seq 1 45); do
    if curl --fail --silent --max-time 3 http://127.0.0.1:3010/healthz | grep -q '"browser":true'; then return 0; fi
    sleep 2
  done
  return 1
}
echo "Stopping the systemd browser: open remote pages and unsent drafts are interrupted."
systemctl disable --now claude-browser claude-display
if ! docker volume inspect remote-claude-browser_data >/dev/null 2>&1; then
  docker volume create remote-claude-browser_data >/dev/null
  docker run --rm --entrypoint sh --network none \
    -v remote-claude-browser_data:/data -v "$old_profile:/source:ro" "$image" \
    -c 'cp -a /source /data/profile && chown -R 10001:10001 /data /data/profile'
fi
docker compose up -d
if healthy; then
  echo "The container is healthy."
else
  echo "The container did not come up healthy. Going back to systemd." >&2
  docker compose logs --no-color --tail=40 >&2 || true
  back_to_systemd
  exit 1
fi
REMOTE
}

tunnel() {
  local dir=client/ssh
  install -d -m 700 "$dir"
  install -m 600 "$ssh_config_key" "$dir/id_ed25519"
  ssh-keygen -F "$ssh_config_host" -f ~/.ssh/known_hosts | grep -v '^#' >"$dir/known_hosts"
  [ -s "$dir/known_hosts" ] || { echo "No known host key for the server" >&2; exit 1; }
  umask 077
  cat >client/.env <<EOF
PUBLIC_HOST=:80
SERVER_SSH_HOST=$ssh_config_host
SERVER_SSH_PORT=$ssh_config_port
SERVER_SSH_USER=$ssh_config_user
TUNNEL_IMAGE=$tunnel_image
EOF
  docker pull --quiet "$tunnel_image"
  systemctl disable --now claude-tunnel
  if ! (cd client && docker compose -f compose.yml -f compose.tunnel-only.yml up -d tunnel); then
    systemctl enable --now claude-tunnel
    exit 1
  fi
  for _ in $(seq 1 15); do
    if curl --fail --silent --max-time 3 http://127.0.0.1:3010/healthz >/dev/null; then
      echo "The tunnel is up in its container."
      return
    fi
    sleep 2
  done
  echo "The tunnel did not come up. Going back to systemd." >&2
  (cd client && docker compose -f compose.yml -f compose.tunnel-only.yml down) || true
  systemctl enable --now claude-tunnel
  exit 1
}

rollback() {
  if [ -f client/.env ]; then
    (cd client && docker compose -f compose.yml -f compose.tunnel-only.yml down) || true
  fi
  systemctl enable --now claude-tunnel
  ssh "$remote_host" bash -s -- "$server_dir" <<'REMOTE'
set -euo pipefail
server_dir=$1
if [ -d "$server_dir" ]; then (cd "$server_dir" && docker compose down) || true; fi
systemctl enable --now claude-egress claude-display claude-browser
REMOTE
  echo "Back on systemd. The Docker volume is kept; remove it yourself when it is no longer wanted."
}

case ${1:-} in
  prepare | cutover | tunnel | rollback) "$1" ;;
  *)
    echo "usage: $0 prepare|cutover|tunnel|rollback" >&2
    exit 2
    ;;
esac
