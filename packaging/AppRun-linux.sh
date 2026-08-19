#! /usr/bin/env bash
set -e

# KAIGEN_APPRUN_BACKEND_POLICY_V1
# linuxdeploy's GTK hook currently forces X11 even inside a native Wayland
# session. Capture a caller override before sourcing the generated hook, then
# restore it exactly or choose the backend that matches the desktop session.
this_dir="$(readlink -f "$(dirname "$0")")"
kaigen_apprun_argv=("$@")
kaigen_session_type="${XDG_SESSION_TYPE-}"
kaigen_wayland_display="${WAYLAND_DISPLAY-}"

gdk_backend_was_set=0
gdk_backend_value=''
if [[ ${GDK_BACKEND+x} == x ]]; then
  gdk_backend_was_set=1
  gdk_backend_value="$GDK_BACKEND"
fi

webkit_dmabuf_was_set=0
webkit_dmabuf_value=''
if [[ ${WEBKIT_DISABLE_DMABUF_RENDERER+x} == x ]]; then
  webkit_dmabuf_was_set=1
  webkit_dmabuf_value="$WEBKIT_DISABLE_DMABUF_RENDERER"
fi

source "$this_dir"/apprun-hooks/"linuxdeploy-plugin-gtk.sh"

if [[ $gdk_backend_was_set -eq 1 ]]; then
  export GDK_BACKEND="$gdk_backend_value"
elif [[ $kaigen_session_type == wayland && -n $kaigen_wayland_display ]]; then
  export GDK_BACKEND=wayland
fi

# Apply the renderer fallback before GTK/WebKit libraries enter the process,
# while restoring explicit values including an empty string and `0` even if a
# generated hook changes the environment.
if [[ $webkit_dmabuf_was_set -eq 1 ]]; then
  export WEBKIT_DISABLE_DMABUF_RENDERER="$webkit_dmabuf_value"
else
  export WEBKIT_DISABLE_DMABUF_RENDERER=1
fi

exec "$this_dir"/AppRun.wrapped "${kaigen_apprun_argv[@]}"
