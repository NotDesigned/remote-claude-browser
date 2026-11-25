#!/bin/sh
# Chromium sees one profile, one X display and a private /proc; the gateway stays outside.
set -eu
umask 022
if [ "${1:-}" != --inside ]; then
  exec unshare --mount --pid --fork --kill-child "$0" --inside "$@"
fi
shift
root=$1
profile=$2
shift 2
mount --make-rprivate /
# Empty outer mount point; each namespace fills it only with its own extension.
mkdir -p /C:
mkdir -p "$root"
mount -t tmpfs -o mode=0755,size=32m tmpfs "$root"
mkdir -p "$root"/usr "$root"/etc "$root"/dev "$root"/proc "$root"/tmp "$root"/run
mount --bind /usr "$root/usr"
mount -o remount,bind,ro "$root/usr"
for directory in bin sbin lib lib64; do
  if [ -L "/$directory" ]; then
    ln -s "$(readlink "/$directory")" "$root/$directory"
  elif [ -d "/$directory" ]; then
    mkdir "$root/$directory"
    mount --bind "/$directory" "$root/$directory"
    mount -o remount,bind,ro "$root/$directory"
  fi
done
bind_readonly() {
  source=$1
  mkdir -p "$root$(dirname "$source")"
  if [ -d "$source" ]; then mkdir -p "$root$source"; else touch "$root$source"; fi
  mount --bind "$source" "$root$source"
  mount -o remount,bind,ro "$root$source"
}
# Docker mounts the optional engine below /usr. A plain bind of /usr omits submounts.
if [ -d /usr/local/lib/aliasmode ]; then bind_readonly /usr/local/lib/aliasmode; fi
if [ -d /usr/local/share/fonts/fingerprint ]; then bind_readonly /usr/local/share/fonts/fingerprint; fi
if [ -d /var/cache/fontconfig-fingerprint ]; then bind_readonly /var/cache/fontconfig-fingerprint; fi
for path in /etc/chromium.d /etc/fonts /var/cache/fontconfig /etc/ssl/certs /etc/passwd /etc/group /etc/nsswitch.conf /etc/hosts /etc/resolv.conf /etc/ld.so.cache; do
  bind_readonly "$path"
done
timezone=${TZ:-Etc/UTC}
ln -s "/usr/share/zoneinfo/$timezone" "$root/etc/localtime"
printf '%s\n' "$timezone" > "$root/etc/timezone"
# This also covers native browser navigation, history and links outside the workbench URL bar.
mkdir -p "$root/etc/chromium/policies/managed"
printf '%s\n' '{"URLBlocklist":["file://*","filesystem:*","javascript:*"],"URLAllowlist":["about:blank"]}' > "$root/etc/chromium/policies/managed/workspace.json"
# Nobody can click Chromium's own bubbles in the picture, such as "Save password?": turn them off.
cp "$(dirname "$0")/browser-policies.json" "$root/etc/chromium/policies/managed/remote-browser.json"
# Chromium needs Secure DNS to use ECH. Both DoH and fallback DNS stay on this profile's exit.
if [ -n "${MIRROR_BROWSER_DOH_TEMPLATE:-}" ]; then
  printf '{"DnsOverHttpsMode":"automatic","DnsOverHttpsTemplates":"%s"}\n' \
    "$MIRROR_BROWSER_DOH_TEMPLATE" > "$root/etc/chromium/policies/managed/secure-dns.json"
fi
mount -t tmpfs -o mode=1777,size=512m tmpfs "$root/tmp"
mount -t tmpfs -o mode=0755,size=1m tmpfs "$root/dev"
for device in null zero full random urandom tty; do
  touch "$root/dev/$device"
  mount --bind "/dev/$device" "$root/dev/$device"
done
mkdir "$root/dev/shm"
mount -t tmpfs -o mode=1777,size=256m tmpfs "$root/dev/shm"
ln -s /proc/self/fd "$root/dev/fd"
ln -s /proc/self/fd/0 "$root/dev/stdin"
ln -s /proc/self/fd/1 "$root/dev/stdout"
ln -s /proc/self/fd/2 "$root/dev/stderr"
mount -t proc -o nosuid,nodev,noexec proc "$root/proc"
mkdir -p "$root$profile" "$root/tmp/home"
mount --bind "$profile" "$root$profile"
# Windows personas parse file:////data/... as a UNC host. A drive-qualified
# mount keeps extension file URLs local; a symlink would be undone by realpath.
/usr/bin/setpriv --reuid=10001 --regid=10001 --clear-groups --inh-caps=-all \
  /bin/mkdir -p "$profile/zoom-extension"
mkdir -p "$root/C:/zoom-extension"
mount --bind "$profile/zoom-extension" "$root/C:/zoom-extension"
mount -o remount,bind,ro "$root/C:/zoom-extension"
chown 10001:10001 "$root/tmp/home"
if [ -n "${DISPLAY:-}" ]; then
  display_number=${DISPLAY#:}
  case "$display_number" in ''|*[!0-9]*) exit 1;; esac
  bind_readonly "/tmp/.X11-unix/X$display_number"
  bind_readonly "$XAUTHORITY"
fi
cd "$root"
# Keep the mount namespace's root: chroot blocks Chromium's nested user namespace,
# and Docker's default seccomp blocks pivot_root. Cover every original root entry
# with the allowlisted tree instead. New user namespaces cannot unmount these
# inherited mounts; the private PID namespace removes /proc paths to outer roots.
for path in /* /.[!.]* /..?*; do
  case "$path" in /bin|/sbin|/lib|/lib64) continue;; esac
  if [ -d "$path" ]; then
    name=${path#/}
    mkdir -p "./$name"
    mount --rbind "./$name" "$path"
  elif [ -e "$path" ]; then
    mount --bind /dev/null "$path"
  fi
done
cd /
# The broker permits only one process per profile; sockets from a crashed namespace are stale.
/usr/bin/setpriv --reuid=10001 --regid=10001 --clear-groups --inh-caps=-all \
  /bin/rm -f "$profile/SingletonLock" "$profile/SingletonSocket" "$profile/SingletonCookie"
# Keep the namespace init as root: setuid clears the parent-death signal installed by unshare.
/usr/bin/setpriv --reuid=10001 --regid=10001 --clear-groups --inh-caps=-all "$@" &
browser_pid=$!
trap 'kill -TERM "$browser_pid" 2>/dev/null || true' TERM INT
wait "$browser_pid"
