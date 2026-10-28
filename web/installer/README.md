# Kaigen Web — Debian 13 + Nginx

## Canonical SSH installer

The maintained public installer is [`kaigenweb.sh`](../../kaigenweb.sh). Every release publishes an exact copy as `Kaigen-Web-Installer-<version>.sh`; edit the canonical file when maintaining the installer. The release filename stays compatible with existing download links.

Download it into any directory and run it with Bash:

```bash
curl -fL https://github.com/kaigendev/Kaigen/releases/download/v0.3.3/Kaigen-Web-Installer-0.3.3.sh -o kaigenweb.sh
bash kaigenweb.sh
```

For later releases use that release's `Kaigen-Web-Installer-<version>.sh` download link. The installer itself downloads the latest stable official Web bundle and checks its GitHub SHA-256 digest and bundle manifest. It asks for Russian or English, obtains root privileges through sudo or su, installs missing dependencies, and offers personal/service mode, IP/domain, optional Tor, service quotas and HTTPS. HTTPS supports automatic Let's Encrypt, an existing certificate/key, or a self-signed certificate after explicit consent. Re-running offers resume/removal of an incomplete installation, update, uninstall or a clean reinstall.

`scripts/build-web-installer.ps1` packages this exact file for normal releases. `.github/workflows/publish-web-installer.yml` can replace only the installer in an existing release through GitHub Actions, preserving its tag and other assets. The old `install-kaigen-web-from-github.sh` template and version-specific historical workflow are retained for historical compatibility and are not used by the current packager.

Immediately after mode selection, the installer asks for the workspace deletion timer in whole hours. Personal mode defaults to `0` (disabled); service mode defaults to `72`. Enter accepts the offered value, and `0` disables deletion in either mode. The selected value survives an interrupted installation, reboot and update. Earlier installer state without this setting retains its original 72 hours. The backend assigns the duration when creating each workspace; existing workspace metadata is preserved, including its normal renewal, transfer-extension and grace behavior.

## Legacy bundle installer

The following describes the older low-level installer bundled with the Web payload. Existing slot-based installations can continue using its explicit commands.

This bundle installs the native `kaigen-webd` backend and the Web UI behind Nginx. Its payload includes `bin/kaigen-webd`, the pinned `lib/Kaigen/libtoxcore.so.2.24.0`, and the pinned Linux `TorExpertBundle` with `lyrebird` for obfs4; each root-owned slot loads only its release-local runtimes. It does not install or route traffic through Apache, obtain certificates, or download dependencies. Debian 13, Nginx, systemd, `curl`, `sha256sum`, `ss`, and an existing TLS certificate/key are required.

Historical bootstrap assets downloaded an exact same-version bundle and delegated to this low-level installer. The canonical SSH installer described above manages its own installation and does not invoke the legacy installer.

Run as root:

```bash
./install-kaigen-web.sh install --bundle .
```

The interactive installer asks for one mode:

- **Personal** — exactly one encrypted workspace. Creation is rejected while it exists and becomes available again after verified destruction. No workspace quotas or systemd resource limits are configured.
- **Service** — multiple workspaces with standard disk/RAM/security quotas and systemd resource limits.

The installer uses two loopback backend slots. `update` starts and health-checks the inactive slot, atomically switches the Nginx upstream, drains established connections, and then stops the old slot. `rollback` performs the same process with the retained previous release.

## Release-critical installation invariants

- The public request path is browser -> Nginx -> loopback-only `kaigen-webd`. Apache must not be active in this path, and the installer refuses to modify conflicting Nginx or systemd files that it does not manage.
- In both the `/api/` and `/ws` locations, Nginx must set `X-Real-IP $remote_addr`. The backend actually reads `x-real-ip` when deriving the client source fingerprint used by source-scoped protections, and accepts that header only from a loopback TCP peer; `X-Forwarded-For` alone is not a substitute. If a trusted reverse proxy or load balancer is later placed in front of Nginx, configure Nginx's trusted `real_ip` sources so that `$remote_addr` is the reconstructed client address. Never trust a client-supplied forwarding header directly.
- The existing TLS certificate must be valid for the exact installation hostname, including a matching Subject Alternative Name. The installer does not obtain or renew certificates.
- The selected `kaigen-webd@a.service` or `kaigen-webd@b.service` slot must be enabled and active, while the replaced slot must be disabled and stopped. The `run-kaigen\x2dwebd.mount` tmpfs mount and Nginx must also be enabled. Installation, update, and rollback must pass the active slot's direct loopback `/healthz` and `/readyz` checks and `nginx -t` before traffic is switched; verify enabled/active state again after a reboot.
- `release-id`, `payload/ui/kaigen-build-id`, the build ID embedded in the SPA, and the active Nginx runtime identity are one immutable value. The installer rejects a mismatched bundle or rollback target. Nginx serves the no-store `/api/v1/build-identity` endpoint and returns `UPGRADE_REQUIRED` before proxying API or WebSocket traffic when an old or mismatched SPA omits the active build ID.
- Backend health and readiness are checked directly on the active loopback port (`8787` or `8788`). The public routes are the Web UI at `/`, API calls under `/api/v1/`, and WebSocket traffic at `/ws`; a public SPA response is not backend health evidence.
- Installation remains self-contained and offline: every immutable `/opt/kaigen-webd/releases/<release-id>` slot uses its own pinned `libtoxcore`, Tor runtime, `lyrebird`, and UI/backend payload through slot-specific runtime paths. Do not replace them with system copies or download dependencies during install/update.

```bash
./install-kaigen-web.sh update --bundle /path/to/new-bundle
./install-kaigen-web.sh rollback
./install-kaigen-web.sh uninstall
```

Uninstall preserves encrypted workspace data by default. Deleting it requires a separate explicit `ERASE` confirmation. Certificates and unrelated Nginx configuration are never removed.
