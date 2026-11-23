#! /usr/bin/env bash
set -e

# KAIGEN_APPRUN_BACKEND_POLICY_V1
# Capture a caller override before sourcing the pinned GTK hook, then restore
# it exactly or choose the backend that matches the desktop session.
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

# AppRun.wrapped overwrites the GStreamer system paths. Pass the intended
# value to the entry script that runs after it, including an explicit empty
# override when the caller has disabled system plugin discovery.
unset KAIGEN_APPIMAGE_GST_SYSTEM_PATH
if [[ -v GST_PLUGIN_SYSTEM_PATH_1_0 ]]; then
  export KAIGEN_APPIMAGE_GST_SYSTEM_PATH="$GST_PLUGIN_SYSTEM_PATH_1_0"
elif [[ -v GST_PLUGIN_SYSTEM_PATH ]]; then
  export KAIGEN_APPIMAGE_GST_SYSTEM_PATH="$GST_PLUGIN_SYSTEM_PATH"
elif [[ -d "$this_dir/usr/lib/gstreamer-1.0" ]]; then
  export KAIGEN_APPIMAGE_GST_SYSTEM_PATH="$this_dir/usr/lib/gstreamer-1.0"
else
  gst_host_dirs=(/usr/lib/x86_64-linux-gnu/gstreamer-1.0 /usr/lib64/gstreamer-1.0 /usr/lib/gstreamer-1.0)
  gst_data_home="${XDG_DATA_HOME:-${HOME:+$HOME/.local/share}}"
  if [[ -n $gst_data_home ]]; then
    gst_host_dirs=("$gst_data_home/gstreamer-1.0/plugins" "${gst_host_dirs[@]}")
  fi
  gst_host_path=''
  for gst_dir in "${gst_host_dirs[@]}"; do
    if [[ -d $gst_dir ]]; then
      gst_host_path+="${gst_host_path:+:}$gst_dir"
    fi
  done
  if [[ -n $gst_host_path ]]; then
    export KAIGEN_APPIMAGE_GST_SYSTEM_PATH="$gst_host_path"
  fi
fi

exec "$this_dir"/AppRun.wrapped "${kaigen_apprun_argv[@]}"
