# Kaigen Web — Debian 13 + Nginx

## Canonical SSH installer

The maintained public installer is [`kaigenweb.sh`](../../kaigenweb.sh). Every release publishes an exact copy as `Kaigen-Web-Installer-<version>.sh`; edit the canonical file when maintaining the installer. The release filename stays compatible with existing download links.

Download it into any directory and run it with Bash:

```bash
curl -fL https://github.com/kaigendev/Kaigen/releases/download/v0.3.3/Kaigen-Web-Installer-0.3.3.sh -o kaigenweb.sh
bash kaigenweb.sh
```

For later releases use that release's `Kaigen-Web-Installer-<version>.sh` download link. The installer downloads the latest stable numeric official Web release. It excludes drafts, prereleases and names or tags containing `RC` in any letter case, and verifies the archive's GitHub SHA-256 digest before safe extraction. It asks for Russian or English, obtains root privileges through sudo or su, installs missing dependencies, and offers personal/service mode, IP/domain, optional Tor, service quotas and HTTPS. HTTPS supports automatic Let's Encrypt, an existing certificate/key, or a self-signed certificate after explicit consent. Re-running offers resume/removal of an incomplete installation, update, uninstall or a clean reinstall.

The automatic Let's Encrypt option uses `acme.sh`. Keep port 80 reachable for HTTP-01 challenges. The `kaigenweb-acme.timer` checks hourly and the renewal hook validates the Kaigen Nginx configuration before reloading it. An administrator who selects an existing PEM pair manages its renewal. The certificate timer operates independently of automatic Kaigen release updates.

During installation, choose whether to enable automatic updates. The root-owned systemd timer checks daily; updates preserve encrypted workspace data. The same release-only operation can run once manually, without upgrading operating-system packages:

```bash
sudo bash kaigenweb.sh --update
sudo bash kaigenweb.sh --update --auto-updates on
sudo bash kaigenweb.sh --update --auto-updates off
```

Existing `/opt/kaigenweb` and legacy `/opt/kaigen-webd` installations are supported. When both exist, add `--layout canonical` or `--layout legacy`. A candidate first passes workspace creation/deletion against isolated storage on loopback port `18787`. The installer verifies the old backend's clean exit before starting the replacement on the alternate `8787`/`8788` slot and switching Nginx. A durable journal and boot recovery restore an interrupted transaction before any backend writer starts. Scheduled output never prints personal workspace access credentials.

`scripts/build-web-installer.ps1` packages this exact file for normal releases. `.github/workflows/publish-web-installer.yml` can replace only the installer in an existing release through GitHub Actions, preserving its tag and other assets. The old `install-kaigen-web-from-github.sh` template and version-specific historical workflow are retained for historical compatibility and are not used by the current packager.

Immediately after mode selection, the installer asks for the workspace deletion timer in whole hours. Personal mode defaults to `0` (disabled); service mode defaults to `72`. Enter accepts the offered value, and `0` disables deletion in either mode. The selected value survives an interrupted installation, reboot and update. Earlier installer state without this setting retains its original 72 hours. The backend assigns the duration when creating each workspace; existing workspace metadata is preserved, including its normal renewal, transfer-extension and grace behavior.

## Legacy bundle installer

The following describes the older low-level installer bundled with the Web payload. Existing slot-based installations can continue using its explicit commands.

This bundle installs the native `kaigen-webd` backend and the Web UI behind Nginx. Its payload includes `bin/kaigen-webd`, the pinned `lib/Kaigen/libtoxcore.so.2.24.0`, and the pinned Linux `TorExpertBundle` with `lyrebird` for obfs4; each root-owned slot loads only its release-local runtimes. It does not install or route traffic through Apache, obtain certificates, or download dependencies. Debian 13, Nginx, systemd, `curl`, `sha256sum`, `ss`, and an existing TLS certificate/key are required.

Historical bootstrap assets downloaded an exact same-version bundle and delegated to this low-level installer. The canonical installer maintains its own layout and embeds an exact copy of this low-level transaction for updating existing legacy installations. After editing the low-level installer, run `node scripts/sync-web-installer-adapter.mjs`; packaging fails if the embedded bytes differ from its maintained source.

Run as root:

```bash
./install-kaigen-web.sh install --bundle .
```

The interactive installer asks for one mode:

- **Personal** — exactly one encrypted workspace. Creation is rejected while it exists and becomes available again after verified destruction. No workspace quotas or systemd resource limits are configured.
- **Service** — multiple workspaces with standard disk/RAM/security quotas and systemd resource limits.

The installer uses two loopback backend slots sharing one storage root. `update` checks the candidate against isolated storage, verifies the previous writer's clean stop, starts the inactive slot, and switches the Nginx upstream. `rollback` restores the retained previous release through the same single-writer handoff.

## Release-critical installation invariants

- The public request path is browser -> Nginx -> loopback-only `kaigen-webd`. Apache must not be active in this path, and the installer refuses to modify conflicting Nginx or systemd files that it does not manage.
- In both the `/api/` and `/ws` locations, Nginx must set `X-Real-IP $remote_addr`. The backend actually reads `x-real-ip` when deriving the client source fingerprint used by source-scoped protections, and accepts that header only from a loopback TCP peer; `X-Forwarded-For` alone is not a substitute. If a trusted reverse proxy or load balancer is later placed in front of Nginx, configure Nginx's trusted `real_ip` sources so that `$remote_addr` is the reconstructed client address. Never trust a client-supplied forwarding header directly.
- The existing TLS certificate must be valid for the exact installation hostname, including a matching Subject Alternative Name. If the paths match an existing Certbot webroot lineage, the installer serves `/.well-known/acme-challenge/` from that lineage's configured webroot on port 80 and redirects other HTTP requests to HTTPS. Keep port 80 reachable for every hostname in the lineage. Certbot and its `certbot.timer` must already be installed. The installer enables the timer and adds a deploy hook that validates and reloads Nginx after that lineage renews. The timer runs independently of Kaigen release updates. Administrators manage other certificate sources and any initial certificate issuance.
- The selected `kaigen-webd@a.service` or `kaigen-webd@b.service` slot must be enabled and active, while the replaced slot must be disabled and stopped. The `run-kaigen\x2dwebd.mount` tmpfs mount and Nginx must also be enabled. Installation, update, and rollback must pass the active slot's direct loopback `/healthz` and `/readyz` checks and `nginx -t` before traffic is switched; verify enabled/active state again after a reboot.
- `release-id`, `payload/ui/kaigen-build-id`, the build ID embedded in the SPA, and the active Nginx runtime identity are one immutable value. The installer rejects a mismatched bundle or rollback target. Nginx serves the no-store `/api/v1/build-identity` endpoint and returns `UPGRADE_REQUIRED` before proxying API or WebSocket traffic when an old or mismatched SPA omits the active build ID.
- Backend health and readiness are checked directly on the active loopback port (`8787` or `8788`). The public routes are the Web UI at `/`, API calls under `/api/v1/`, and WebSocket traffic at `/ws`; a public SPA response is not backend health evidence.
- Installation remains self-contained and offline: every immutable `/opt/kaigen-webd/releases/<release-id>` slot uses its own pinned `libtoxcore`, Tor runtime, `lyrebird`, and UI/backend payload through slot-specific runtime paths. Do not replace them with system copies or download dependencies during install/update.

```bash
./install-kaigen-web.sh update --bundle /path/to/new-bundle
./install-kaigen-web.sh update --archive /path/to/bundle.tar.gz --archive-sha256 <trusted-sha256> --non-interactive
./install-kaigen-web.sh rollback
./install-kaigen-web.sh uninstall
```

Uninstall preserves encrypted workspace data by default. Deleting it requires a separate explicit `ERASE` confirmation. Certificates and unrelated Nginx configuration are never removed.

Archive admission checks the complete archive digest and permits only bounded regular files/directories with safe unique paths. Explicit `--bundle` directory admission retains its strict manifest checks. Both fresh-install and update Nginx renderers forward workspace-scoped `/IDENT/api` routes, including `/space/IDENT/api` and `/w/IDENT/api`, with authorization headers and streaming support; these paths do not fall through to the SPA.
