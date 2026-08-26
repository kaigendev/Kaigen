# Kaigen Web — Debian 13 + Nginx

This bundle installs the native `kaigen-webd` backend and the Web UI behind Nginx. Its payload includes `bin/kaigen-webd`, the pinned `lib/Kaigen/libtoxcore.so.2.23.0`, and the pinned Linux `TorExpertBundle` with `lyrebird` for obfs4; each root-owned slot loads only its release-local runtimes. It does not install or route traffic through Apache, obtain certificates, or download dependencies. Debian 13, Nginx, systemd, `curl`, `sha256sum`, `ss`, and an existing TLS certificate/key are required.

Run as root:

```bash
./install-kaigen-web.sh install --bundle .
```

The interactive installer asks for one mode:

- **Personal** — exactly one encrypted workspace. Creation is rejected while it exists and becomes available again after verified destruction. No workspace quotas or systemd resource limits are configured.
- **Service** — multiple workspaces with standard disk/RAM/security quotas and systemd resource limits.

The installer uses two loopback backend slots. `update` starts and health-checks the inactive slot, atomically switches the Nginx upstream, drains established connections, and then stops the old slot. `rollback` performs the same process with the retained previous release.

```bash
./install-kaigen-web.sh update --bundle /path/to/new-bundle
./install-kaigen-web.sh rollback
./install-kaigen-web.sh uninstall
```

Uninstall preserves encrypted workspace data by default. Deleting it requires a separate explicit `ERASE` confirmation. Certificates and unrelated Nginx configuration are never removed.
