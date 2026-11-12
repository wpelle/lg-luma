#!/bin/sh
# Optional native Home replacement. The webosbrew hook has no .sh suffix.
STATE=/var/lib/luma-home
# The cold-boot hook is a symlink to the copied $STATE/home.sh: find luma-helper beside its target.
SCRIPT=$0
if [ -L "$SCRIPT" ]; then
  LINK=$(readlink "$SCRIPT") || exit 1
  case "$LINK" in /*) SCRIPT=$LINK ;; *) SCRIPT=$(dirname -- "$SCRIPT")/$LINK ;; esac
fi
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$SCRIPT")" && pwd) || exit 1
COMMAND=${1:-boot}
case "$COMMAND" in
  enable|disable|restore|status|apply|boot|early) ;;
  *) printf '%s\n' 'Usage: home.sh enable [APP_DIR] [HOME_ID] | disable | restore | status' >&2; exit 1 ;;
esac
[ "$(id -u)" = 0 ] || { printf '%s\n' 'Run as root.' >&2; exit 1; }
# boot only schedules the copied $STATE/home.sh apply, which checks for the helper itself; the
# early fast path is shell only.
case "$COMMAND" in
  boot|early) ;;
  *) [ -x "$SCRIPT_DIR/luma-helper" ] ||
    { printf '%s\n' 'The native Luma TV helper is missing.' >&2; exit 1; } ;;
esac
if [ "$COMMAND" = enable ] && grep -q 'release [569]\.' /etc/starfish-release 2>/dev/null; then
  printf '%s\n' \
    'Enabling Luma Home (webOS 5/6/24) will:' \
    '  1. Close any running normal Luma instance.' \
    "  2. Create $STATE with integration scripts and saved state." \
    "  3. Bind-mount Luma's executable over the selected LG Home executable." \
    "     LG's Home manifest and role stay; Luma registers with SAM itself." \
    '  4. Stop the previous Home process and launch Luma as Home.' \
    '  5. Install /var/lib/webosbrew/init.d/64-luma-home to reapply the mount at cold boot.' \
    '  6. Register the LS2 service com.webos.service.lumahome (luma-early) and a compositor key' \
    '     filter, so a cold boot opens Luma at about 20 s instead of after the Homebrew hooks.' \
    '' \
    "LG Home's original executable remains underneath the mount." \
    'Home Auto Launch and Quick Start+ retain their current settings.' \
    "Restore LG Home with: sh $STATE/home.sh disable" \
    ''
elif [ "$COMMAND" = enable ]; then
  printf '%s\n' \
    'Enabling Luma Home will:' \
    '  1. Close any running normal Luma instance.' \
    "  2. Create $STATE with integration scripts, saved state and a staged native Home app linked to Luma." \
    "  3. Bind-mount $STATE/app over /usr/palm/applications/com.webos.app.home." \
    '  4. Temporarily block and release Home so SAM rereads its manifest.' \
    '  5. Stop the previous Home process and launch Luma as Home.' \
    '  6. Install /var/lib/webosbrew/init.d/64-luma-home to reapply the mount at cold boot.' \
    '  7. Register the LS2 service com.webos.service.lumahome (luma-early) and a compositor key' \
    "     filter, so a cold boot takes over Home at about 12 s, before LG's Home is shown." \
    '' \
    "LG Home's original files remain underneath the mount." \
    'Home Auto Launch and Quick Start+ retain their current settings.' \
    "Restore LG Home with: sh $STATE/home.sh disable" \
    ''
fi
if [ "$COMMAND" = enable ]; then
  printf '%s\n' "Selected Home target: ${3:-saved target, otherwise com.webos.app.home}"

  while :; do
    printf '%s' 'Apply these changes? [y/n]: '
    if ! IFS= read -r answer; then
      printf '\n%s\n' 'Cancelled. No Home integration changes applied.'
      exit 1
    fi
    case "$answer" in
      y|Y) break ;;
      n|N) printf '%s\n' 'Cancelled. No Home integration changes applied.'; exit 0 ;;
      *) printf '%s\n' 'Please answer y or n.' ;;
    esac
  done
fi
[ ! -L "$STATE" ] || exit 1
if [ ! -d "$STATE" ]; then mkdir -m 755 "$STATE" || exit 1; fi
[ "$(stat -c %u "$STATE")" = 0 ] || exit 1
MARKER=/var/run/luma-home
# Written by the manifest method's early start (webOS 25/26) for this boot only; the boot hook
# then leaves the takeover alone. Separate from $MARKER, which redirects normal Luma tile launches.
EARLY_MARKER=/var/run/luma-home-early
if [ "$COMMAND" = early ] || [ "$COMMAND" = boot ]; then
  # The Home target chosen at enable (luma-helper home); configurations without one use home.
  HOME_ID=$(sed -n 's/^  "homeId": "\([^"]*\)".*/\1/p' "$STATE/state.json" 2>/dev/null)
  case "${HOME_ID:=com.webos.app.home}" in
    com.webos.app.home|com.webos.app.fullhome) ;;
    *) printf '%s\n' "Unsupported Home target: $HOME_ID" >&2; exit 1 ;;
  esac
  EXE=/usr/bin/$HOME_ID
fi
if [ "$COMMAND" = early ]; then
  # From luma-early, early in a cold boot (see src/bin/luma-early.rs), without the native helper,
  # which would cost seconds under boot load. Any failure leaves the boot hook below to do it.
  # ls-hubd may start luma-early with a minimal environment.
  PATH=$PATH:/usr/sbin:/usr/bin:/sbin:/bin
  exec 9>"$STATE/lock"
  flock -w 10 9 || exit 1
  config=$(cat "$STATE/state.json" 2>/dev/null) || exit 1
  case "$config" in *'"enabled": true'*) ;; *) exit 1 ;; esac
  app=$(printf '%s\n' "$config" | sed -n 's/^  "appDir": "\([^"]*\)".*/\1/p')
  [ -x "$app/luma" ] || exit 1
  case "$config" in
    *'"method": "executable"'*) ;;
    *'"method": "manifest"'*)
      # webOS 25/26: the helper's manifest takeover (tv-helper/src/home.rs apply) in shell.
      # ls-hubd routes the call from the volatile scan in snapshot-boot-resume (~12 s on a
      # webOS 26 C3), while bootd launches its first app, Home, at ~13 s behind the boot-logo
      # cover (lifted at ~15 s). Done before that launch, bootd's own launch opens Luma.
      TARGET=/usr/palm/applications/$HOME_ID
      STAGE=$STATE/app
      luna() {
        /usr/bin/luna-send -n 1 -w 5000 "luna://com.webos.applicationManager/$1" "$2" </dev/null 2>/dev/null
      }
      lower() { printf '%s\n' "$1" | tr 'A-Z' 'a-z'; }
      accepted() { case "$1" in *'"returnValue":true'*|*'"returnValue": true'*) return 0 ;; esac; return 1; }
      same() {
        a=$(stat -c '%d %i' "$1" 2>/dev/null) && b=$(stat -c '%d %i' "$2" 2>/dev/null) && [ "$a" = "$b" ]
      }
      log() { printf '%s early: %s (uptime %s)\n' "$(date)" "$1" "$(cut -d' ' -f1 /proc/uptime)" >>"$STATE/boot.log"; }
      reread_done() {
        # SAM resolves Home to the staged Luma manifest (as Home::reread checks).
        info=$(luna getAppInfo "{\"id\":\"$HOME_ID\"}")
        accepted "$info" &&
          printf '%s\n' "$info" | grep -q '"type": *"native"' &&
          printf '%s\n' "$info" | grep -Eq '"main": *"([^"]*/)?luma"' &&
          printf '%s\n' "$info" | grep -Eq '"appCategory": *\[[^]]*"home"'
      }
      release() {
        r=0
        while [ $r -lt 3 ]; do
          reply=$(luna releaseBlockSystemApp "{\"id\":\"$HOME_ID\"}")
          accepted "$reply" && return 0
          case "$(lower "$reply")" in *not*blocked*) return 0 ;; esac
          r=$((r + 1)); usleep 250000
        done
        return 1
      }
      undo() {
        # Never leave SAM's Home manifest pointing at Luma's stage, or Home blocked: unmount, then
        # (block and) release so SAM rereads LG's own manifest.
        umount "$TARGET" 2>/dev/null || umount -l "$TARGET" 2>/dev/null
        [ "$1" = released ] && luna blockSystemApp "$block" >/dev/null
        release
        log "failed: $2"
        exit 1
      }
      lg_home_pids() {
        # LG's own Home: its Flutter client for this id, or a native /usr/bin/<id>.
        for dir in /proc/[0-9]*; do
          # Split on purpose (without globbing): only the program and the -i <id> pair matter.
          set -f
          # shellcheck disable=SC2046
          set -- $(tr '\0' ' ' <"$dir/cmdline" 2>/dev/null)
          set +f
          [ $# -gt 0 ] || continue
          main=$1
          if [ "$main" = "/usr/bin/$HOME_ID" ]; then echo "${dir#/proc/}"; continue; fi
          [ "${main##*/}" = flutter-client ] || continue
          while [ $# -gt 1 ]; do
            if [ "$1" = -i ] && [ "$2" = "$HOME_ID" ]; then echo "${dir#/proc/}"; break; fi
            shift
          done
        done
      }
      stop_lg_home() {
        # Returns 0 if LG's Home ran and was stopped, 1 if none ran, 2 if one would not stop.
        pids=$(lg_home_pids)
        [ -n "$pids" ] || return 1
        for pid in $pids; do kill "$pid" 2>/dev/null; done
        i=0
        for pid in $pids; do
          while [ -d "/proc/$pid" ] && [ $i -lt 20 ]; do i=$((i + 1)); usleep 250000; done
        done
        for pid in $pids; do [ -d "/proc/$pid" ] && return 2; done
        return 0
      }
      block="{\"id\":\"$HOME_ID\"}"
      if grep -q '"forceBlockSystemApp"' /etc/palm/schemas/sam/applicationManager.blockSystemApp.schema 2>/dev/null; then
        block="{\"id\":\"$HOME_ID\",\"forceBlockSystemApp\":false}"
      fi
      if ! same "$STAGE" "$TARGET"; then
        [ -f "$STAGE/appinfo.json" ] && [ -f "$STAGE/.luma-home" ] || exit 1
        # Another integration mounted over LG Home: the boot hook reports it.
        awk -v t="$TARGET" '$2 == t || index($2, t "/") == 1 { found = 1 } END { exit !found }' /proc/mounts && exit 1
        # Blocked while the stage is mounted, so bootd's launch cannot start LG's Flutter client
        # on Luma's files with the manifest SAM still has cached; a rejected launch is covered by
        # the key filter.
        reply=$(luna blockSystemApp "$block")
        if ! accepted "$reply"; then
          case "$(lower "$reply")" in *already*blocked*) ;; *) release; log "block refused: $reply"; exit 1 ;; esac
        fi
        mount --bind "$STAGE" "$TARGET" || undo blocked mount
        same "$STAGE" "$TARGET" || undo blocked "mount did not take"
        release || undo blocked release
      fi
      n=0
      until reread_done; do
        n=$((n + 1))
        if [ $n -ge 20 ]; then undo released "SAM did not read the Luma manifest"; fi
        usleep 250000
      done
      stop_lg_home; stopped=$?
      [ $stopped -eq 2 ] && { log "LG Home did not stop"; exit 1; }
      if [ $stopped -eq 0 ]; then
        luna launch "{\"id\":\"$HOME_ID\"}" >/dev/null
        log "Luma is Home (LG Home was running, stopped and replaced)"
      else
        log "Luma is Home (before LG Home started)"
      fi
      printf '%s\n' manifest >"$EARLY_MARKER"
      # bootd's first launch can still be under way: for a few seconds after it reports the
      # first app launched, replace an LG Home that starts anyway. Without the lock.
      (
        exec 9>&-
        clean=0 n=0
        while [ $n -lt 40 ] && [ $clean -lt 4 ]; do
          n=$((n + 1))
          usleep 500000
          stop_lg_home
          case $? in
            0) luna launch "{\"id\":\"$HOME_ID\"}" >/dev/null; log "replaced a late LG Home"; clean=0 ;;
            2) log "a late LG Home did not stop"; exit 1 ;;
            *) /usr/bin/luna-send -n 1 -w 2000 luna://com.webos.bootManager/getBootStatus '{}' </dev/null 2>/dev/null |
                 grep -q '"firstAppLaunched": *true' && clean=$((clean + 1)) ;;
          esac
        done
      ) </dev/null >/dev/null 2>&1 &
      exit 0 ;;
    *) exit 1 ;;
  esac
  # webOS 5/6/24: mount over LG's Home executable. Opens nothing; the key filter launches Home once
  # this succeeded.
  if ! grep -q " $EXE " /proc/mounts; then
    # LG's Home, restored from the boot snapshot, still runs LG's program.
    old=$(pgrep -f "^$EXE( |\$)")
    mount --bind "$app/luma" "$EXE" || exit 1
    for pid in $old; do kill "$pid" 2>/dev/null; done
    i=0
    for pid in $old; do
      while [ -d "/proc/$pid" ] && [ $i -lt 20 ]; do i=$((i + 1)); usleep 250000; done
    done
  fi
  [ "$(stat -c '%d %i' "$app/luma")" = "$(stat -c '%d %i' "$EXE")" ] || exit 1
  # Luma registers with SAM under this identity (src/platform.rs), as after the helper's apply.
  printf '%s\n' "$HOME_ID" >"$MARKER-target"
  printf '%s\n' com.ecklf.luma >"$MARKER"
  printf '%s early: Luma is Home (uptime %s)\n' "$(date)" "$(cut -d' ' -f1 /proc/uptime)" >>"$STATE/boot.log"
  exit 0
fi
if [ "$COMMAND" = boot ]; then
  # The early helper has already mounted Luma during this boot.
  if [ -f "$MARKER" ] && grep -q " $EXE " /proc/mounts; then exit 0; fi
  if [ -f "$EARLY_MARKER" ] && stage=$(stat -c '%d %i' "$STATE/app" 2>/dev/null) &&
     [ "$stage" = "$(stat -c '%d %i' "/usr/palm/applications/$HOME_ID" 2>/dev/null)" ]; then
    exit 0
  fi
  (
    sleep 5
    exec sh "$STATE/home.sh" apply
  ) </dev/null >>"$STATE/boot.log" 2>&1 &
  exit 0
fi
exec 9>"$STATE/lock"
flock -n 9 || { printf '%s\n' 'Luma Home integration is already being changed.' >&2; exit 1; }
exec "$SCRIPT_DIR/luma-helper" home "$COMMAND" "${2:-$SCRIPT_DIR}" "${3:-}"
