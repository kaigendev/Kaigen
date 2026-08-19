#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd -P)"
template="$project_root/packaging/AppRun-linux.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/kaigen-apprun-test.XXXXXX")"

cleanup() {
  case "$test_root" in
    "${TMPDIR:-/tmp}"/kaigen-apprun-test.*) rm -rf -- "$test_root" ;;
    *) echo "Refusing to clean unsafe AppRun test path: $test_root" >&2; exit 1 ;;
  esac
}
trap cleanup EXIT

appdir="$test_root/AppDir"
mkdir -p "$appdir/apprun-hooks"
install -m 0755 "$template" "$appdir/AppRun"

cat > "$appdir/apprun-hooks/linuxdeploy-plugin-gtk.sh" <<'EOF'
#!/usr/bin/env bash
export APPDIR="${APPDIR:-fake-appdir}"
export GDK_BACKEND=x11
export WEBKIT_DISABLE_DMABUF_RENDERER=hook-mutated
export XDG_SESSION_TYPE=x11
export WAYLAND_DISPLAY=''
set -- hook-mutated
EOF

cat > "$appdir/AppRun.wrapped" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ ${KAIGEN_APPRUN_TEST_MODE-} == signal ]]; then
  printf '%s\n' "$$" > "$KAIGEN_APPRUN_TEST_PID"
  trap 'exit 143' TERM
  while :; do :; done
fi
{
  printf 'GDK_SET=%s\n' "${GDK_BACKEND+x}"
  printf 'GDK_VALUE=%s\n' "${GDK_BACKEND-}"
  printf 'WEBKIT_SET=%s\n' "${WEBKIT_DISABLE_DMABUF_RENDERER+x}"
  printf 'WEBKIT_VALUE=%s\n' "${WEBKIT_DISABLE_DMABUF_RENDERER-}"
  printf 'ARG_COUNT=%s\n' "$#"
  argument_index=0
  for argument in "$@"; do
    printf 'ARG_%s=%s\n' "$argument_index" "$argument"
    argument_index=$((argument_index + 1))
  done
} > "$KAIGEN_APPRUN_TEST_OUTPUT"
exit "${KAIGEN_APPRUN_TEST_EXIT:-0}"
EOF
chmod 0755 "$appdir/AppRun.wrapped"

assert_line() {
  local output="$1"
  local expected="$2"
  if ! grep -Fqx "$expected" "$output"; then
    echo "Missing AppRun matrix result '$expected' in $output" >&2
    cat "$output" >&2
    exit 1
  fi
}

run_case() {
  local name="$1"
  local session_type="$2"
  local wayland_display="$3"
  local gdk_state="$4"
  local gdk_value="$5"
  local webkit_state="$6"
  local webkit_value="$7"
  local expected_gdk="$8"
  local expected_webkit="$9"
  local output="$test_root/$name.txt"
  local -a command=(
    env -i
    "PATH=$PATH"
    "HOME=${HOME:-/tmp}"
    "KAIGEN_APPRUN_TEST_OUTPUT=$output"
  )
  if [[ $session_type != __UNSET__ ]]; then
    command+=("XDG_SESSION_TYPE=$session_type")
  fi
  if [[ $wayland_display != __UNSET__ ]]; then
    command+=("WAYLAND_DISPLAY=$wayland_display")
  fi
  if [[ $gdk_state == set ]]; then
    command+=("GDK_BACKEND=$gdk_value")
  fi
  if [[ $webkit_state == set ]]; then
    command+=("WEBKIT_DISABLE_DMABUF_RENDERER=$webkit_value")
  fi
  command+=("$appdir/AppRun" 'space value' '' '--leading-dash')
  "${command[@]}"

  assert_line "$output" 'GDK_SET=x'
  assert_line "$output" "GDK_VALUE=$expected_gdk"
  assert_line "$output" 'WEBKIT_SET=x'
  assert_line "$output" "WEBKIT_VALUE=$expected_webkit"
  assert_line "$output" 'ARG_COUNT=3'
  assert_line "$output" 'ARG_0=space value'
  assert_line "$output" 'ARG_1='
  assert_line "$output" 'ARG_2=--leading-dash'
}

run_case wayland-default wayland wayland-0 unset '' unset '' wayland 1
run_case x11-default x11 '' unset '' unset '' x11 1
run_case incomplete-wayland wayland '' unset '' unset '' x11 1
run_case absent-session __UNSET__ wayland-0 unset '' unset '' x11 1
run_case contradictory-session x11 wayland-0 unset '' unset '' x11 1
run_case absent-wayland-display wayland __UNSET__ unset '' unset '' x11 1
run_case explicit-x11 wayland wayland-0 set x11 unset '' x11 1
run_case explicit-wayland x11 '' set wayland unset '' wayland 1
run_case explicit-empty-gdk wayland wayland-0 set '' unset '' '' 1
run_case explicit-gdk-zero wayland wayland-0 set 0 unset '' 0 1
run_case explicit-webkit-zero wayland wayland-0 unset '' set 0 wayland 0
run_case explicit-empty-webkit wayland wayland-0 unset '' set '' wayland ''

exit_output="$test_root/exit-status.txt"
set +e
env -i \
  "PATH=$PATH" \
  "HOME=${HOME:-/tmp}" \
  "KAIGEN_APPRUN_TEST_OUTPUT=$exit_output" \
  KAIGEN_APPRUN_TEST_EXIT=37 \
  "$appdir/AppRun"
exit_status=$?
set -e
if [[ $exit_status -ne 37 ]]; then
  echo "AppRun did not preserve wrapped exit status 37: got $exit_status" >&2
  exit 1
fi

signal_pid_file="$test_root/signal.pid"
env -i \
  "PATH=$PATH" \
  "HOME=${HOME:-/tmp}" \
  KAIGEN_APPRUN_TEST_MODE=signal \
  "KAIGEN_APPRUN_TEST_PID=$signal_pid_file" \
  "$appdir/AppRun" &
signal_pid=$!
for _ in {1..100}; do
  [[ -s "$signal_pid_file" ]] && break
  kill -0 "$signal_pid" 2>/dev/null || break
  sleep 0.01
done
if [[ ! -s "$signal_pid_file" || "$(<"$signal_pid_file")" != "$signal_pid" ]]; then
  echo "AppRun did not exec the wrapped process in place" >&2
  kill -TERM "$signal_pid" 2>/dev/null || true
  wait "$signal_pid" 2>/dev/null || true
  exit 1
fi
kill -TERM "$signal_pid"
set +e
wait "$signal_pid"
signal_status=$?
set -e
if [[ $signal_status -ne 143 ]] || kill -0 "$signal_pid" 2>/dev/null; then
  echo "AppRun SIGTERM propagation failed: status=$signal_status pid=$signal_pid" >&2
  exit 1
fi

echo "Linux AppRun backend and WebKit environment matrix passed."
