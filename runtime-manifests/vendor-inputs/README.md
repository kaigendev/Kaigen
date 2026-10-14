# Pinned third-party build inputs

These immutable archives supply the existing managed component preparation route on clean Actions checkouts. They contain third-party Tor transport binaries and the public IPFire country dataset. Existing archive size and SHA-256 pins remain authoritative; missing cache objects can be seeded from these tracked copies, and invalid existing objects still fail verification.

Lyrebird 0.9.0 was compiled from the unmodified official Tor Project source commit 89d54872b176f936232ff39f7a8189b77d83d65e using Go 1.27.2 for Windows/Linux and isolated Go 1.26.8 for macOS, with CGO disabled. The macOS universal binary includes x86_64 and arm64 slices with minimum macOS 12.0. All platform archives contain the upstream LICENSE (Tor Project/Go BSD notices); binary redistribution requires retaining these notices and does not require distributing corresponding source. Source: https://gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/lyrebird/-/tree/89d54872b176f936232ff39f7a8189b77d83d65e .

GeoIP is the IPFire Project Location Database generated 2026-10-14T04:34:25Z, converted into Tor CSV with the unmodified official geoip-db-tool from Tor commit 8fe2745aee2c35116ff1081f19b2952418b43069. Dataset: https://location.ipfire.org/databases/1/location.db.xz . The archive retains CC BY-SA 4.0 license, attribution and conversion provenance; redistribution of this converted dataset follows the same license. License: https://creativecommons.org/licenses/by-sa/4.0/ .

provenance.json records source, toolchain and input/output identities without local cache paths or private service data. These inputs are used by the Actions producers; they are not Kaigen release assets.
