#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: sudo bash install-mirakc.sh /path/to/mirakc/config.yml
       sudo bash install-mirakc.sh --tools-only

Installs mirakc, recisdb, ISDBScanner, libyakisoba, libsobacas and libaribb25.
--tools-only installs recisdb and ISDBScanner so you can generate a configuration first.
Prepare the tuner drivers and firmware for your hardware before scanning.
EOF
}

die() { printf '%s\n' "$*" >&2; exit 1; }
case "${1:-}" in
    -h|--help) usage; exit 0 ;;
esac
[[ $# -eq 1 ]] || { usage >&2; exit 1; }
tools_only=false
if [[ $1 == --tools-only ]]; then
    tools_only=true
else
    [[ -f $1 ]] || die 'Specify an existing mirakc YAML configuration.'
fi
[[ $EUID -eq 0 ]] || die 'Run this installer with sudo.'
source /etc/os-release
[[ "${ID:-}" == debian || "${ID:-}" == ubuntu ]] || die 'This installer requires Debian or Ubuntu.'
arch=$(dpkg --print-architecture)
case "$arch" in
    amd64) scanner_asset=isdb-scanner; scanner_sha=ef524db8b0e421017b59a3a6c7babf73a0fb904b51f2a1517c43b3321b2a7d06 ;;
    arm64) scanner_asset=isdb-scanner-arm; scanner_sha=111ee47eaa3328f468351714df79fb9146fe2ac474e8e75c54273e42395a17b7 ;;
    *) die 'recisdb and ISDBScanner packages require amd64 or arm64.' ;;
esac
if ! $tools_only; then
    [[ -d /run/systemd/system && $arch == amd64 ]] || die 'Full mirakc installation requires amd64 and systemd.'
    if [[ -e /etc/mirakc/config.yml || -e /etc/systemd/system/mirakc.service ]]; then
        die 'mirakc is already configured. Use --tools-only to install scanning tools or connect with install-linux.sh --tuner-url.'
    fi
    if [[ -n $(ss -H -ltn 'sport = :40772') ]]; then
        die 'Port 40772 is in use. Stop the previous tuner server before migrating.'
    fi
fi

apt-get update
apt-get install -y ca-certificates curl
# Use the same image as the Ubuntu deployment. Docker is used to extract the binaries.
image=docker.io/mirakc/mirakc@sha256:bcbf20b211e9a33666797f0a5f3af7b14d9a47ccefd4182f242b0a05a5c0ed82
work=$(mktemp -d)
container=
cleanup() {
    if [[ -n $container ]]; then docker rm "$container" >/dev/null || true; fi
    rm -rf -- "$work"
}
trap cleanup EXIT

recisdb_version=1.2.3
if command -v recisdb >/dev/null; then
    installed_version=$(recisdb --version)
else
    installed_version=
fi
if [[ $installed_version != 'recisdb '* ]] ||
    ! dpkg --compare-versions "${installed_version#recisdb }" ge "$recisdb_version"; then
    package="recisdb_${recisdb_version}-1_${arch}.deb"
    curl -fsSL --retry 3 "https://github.com/kazuki0824/recisdb-rs/releases/download/$recisdb_version/$package" -o "$work/$package"
    chmod 0755 "$work"
    apt-get install -y "$work/$package"
fi
recisdb --version

scanner_version=1.3.3
if [[ -x /usr/local/bin/isdb-scanner ]] &&
    scanner_installed=$(/usr/local/bin/isdb-scanner --version 2>/dev/null) &&
    [[ $scanner_installed == 'ISDBScanner version '* ]] &&
    dpkg --compare-versions "${scanner_installed#ISDBScanner version }" ge "$scanner_version"; then
    printf '%s\n' "$scanner_installed"
else
    curl -fsSL --retry 3 "https://github.com/tsukumijima/ISDBScanner/releases/download/v$scanner_version/$scanner_asset" -o "$work/isdb-scanner"
    printf '%s  %s\n' "$scanner_sha" "$work/isdb-scanner" | sha256sum -c -
    install -m 0755 "$work/isdb-scanner" /usr/local/bin/isdb-scanner
    /usr/local/bin/isdb-scanner --version
fi
if $tools_only; then exit 0; fi

apt-get install -y docker.io python3-yaml kmod build-essential autoconf automake libtool cmake pkg-config libpcsclite-dev pcscd
systemctl start docker.service
install_arib_libraries() {
    for spec in \
        tsunoda14/libyakisoba/03849e66ecb8e89fcdd0862eebcf43255d63794a \
        tsunoda14/libsobacas/77dbb010226d4959f81fc605b588836581dce038 \
        tsukumijima/libaribb25/0676da1cb1e43792555e127a6c062363af7d35c7; do
        repo=${spec%/*}
        commit=${spec##*/}
        name=${repo##*/}
        mkdir "$work/$name"
        curl -fsSL --retry 3 "https://codeload.github.com/$repo/tar.gz/$commit" -o "$work/source.tgz"
        tar -xzf "$work/source.tgz" --no-same-owner --strip-components=1 -C "$work/$name"
        (
            cd "$work/$name"
            if [[ $name == libaribb25 ]]; then
                cmake -S . -B build -DCMAKE_INSTALL_PREFIX=/usr/local -DCMAKE_POLICY_VERSION_MINIMUM=3.5
                cmake --build build --parallel 2
                cmake --install build
            else
                autoreconf -fi
                ./configure --prefix=/usr/local --sysconfdir=/usr/local/etc
                make -j2
                make install
            fi
        )
    done
    ldconfig
    systemctl start pcscd.socket
}
install_arib_libraries
docker pull "$image"
container=$(docker create "$image")
for name in mirakc mirakc-arib recpt1 recdvb; do
    docker cp "$container:/usr/local/bin/$name" "$work/$name"
done
docker cp "$container:/etc/mirakc/strings.yml" "$work/strings.yml"
"$work/mirakc" -V
"$work/mirakc-arib" --help >/dev/null
for name in recpt1 recdvb; do
    if ldd "$work/$name" | grep -q 'not found'; then
        echo "Missing host libraries for $name." >&2
        exit 1
    fi
done
pt3=false
for device in /sys/bus/pci/devices/*; do
    [[ $(cat "$device/vendor") == 0x1172 && $(cat "$device/device") == 0x4c15 &&
        $(cat "$device/subsystem_vendor") == 0xee8d && $(cat "$device/subsystem_device") == 0x0368 ]] || continue
    pt3=true
    break
done
if $pt3; then
    if ! modinfo earth_pt3 >/dev/null 2>&1 && apt-cache show "linux-modules-extra-$(uname -r)" >/dev/null 2>&1; then
        apt-get install -y "linux-modules-extra-$(uname -r)"
    fi
    modprobe earth_pt3
    udevadm settle
    apt-get install -y dvb-tools
fi

python3 - "$1" "$work/config.yml" "$pt3" <<'PY'
from pathlib import Path
import os
import re
import subprocess
import sys
import yaml

source, destination = map(Path, sys.argv[1:3])
config = yaml.safe_load(source.read_text())
if not isinstance(config, dict) or not config.get("channels"):
    raise SystemExit("Configure the channels in the mirakc YAML first.")
tuners = config.setdefault("tuners", [])
if sys.argv[3] == "true":
    detected = []
    for frontend in sorted(Path("/sys/class/dvb").glob("dvb*.frontend*")):
        device = (frontend / "device").resolve()
        if not any((parent / "driver").resolve().name == "earth_pt3" for parent in (device, *device.parents)):
            continue
        adapter, index = re.fullmatch(r"dvb(\d+)\.frontend(\d+)", frontend.name).groups()
        if index != "0":
            raise SystemExit("PT3 requires earth_pt3 with a separate DVB adapter per frontend (one_adapter=0).")
        info = subprocess.check_output(["dvb-fe-tool", "-a", adapter, "-f", index],
                                       text=True, stderr=subprocess.STDOUT, timeout=10,
                                       env={**os.environ, "LC_ALL": "C"})
        terrestrial = bool(re.search(r"\bISDB-?T\b", info, re.I))
        satellite = bool(re.search(r"\bISDB-?S\b", info, re.I))
        if terrestrial == satellite:
            raise SystemExit(f"Could not determine the PT3 delivery system for adapter {adapter}.")
        detected.append(adapter)
        frontend_path = f"/dev/dvb/adapter{adapter}/frontend{index}"
        if any(frontend_path in tuner.get("command", "").split() or
               re.search(rf"(?:--dev(?:\s+|=)){adapter}(?=\s|$)", tuner.get("command", "")) for tuner in tuners):
            continue
        configured_gr = [str(c["channel"]) for c in config["channels"] if c.get("type") == "GR"]
        if any(channel.isdecimal() for channel in configured_gr):
            command = f"/opt/mirakc/bin/recdvb --dev {adapter} " + "{{{channel}}} - -"
        else:
            command = f"recisdb tune --device {frontend_path} --channel " + "{{{channel}}} {{{extra_args}}} -"
        tuners.append({"name": f"PT3 adapter{adapter}", "types": ["GR"] if terrestrial else ["BS", "CS"], "command": command})
    if not detected:
        raise SystemExit("PT3 was detected but earth_pt3 did not expose any DVB frontends.")
    print("PT3 DVB adapters: " + ", ".join(detected))
if not tuners:
    raise SystemExit("Configure tuner commands in the mirakc YAML first.")
if any(re.search(r"(?:^|/)(?:recpt1|recdvb)\s|(?:^|\s)--no-decode(?:\s|$)", tuner.get("command", "")) for tuner in tuners):
    decoder = config.setdefault("filters", {}).setdefault("decode-filter", {})
    decoder.setdefault("command", "/usr/local/bin/arib-b25-stream-test")
config.setdefault("server", {})["addrs"] = [{"http": "127.0.0.1:40772"}]
config.setdefault("epg", {})["cache-dir"] = "/var/lib/mirakc/epg"
config.setdefault("resource", {})["strings-yaml"] = "/etc/mirakc/strings.yml"
destination.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False))
PY

install -d /opt/mirakc/bin /etc/mirakc /var/lib/mirakc/epg
install -m 0755 "$work/mirakc" "$work/mirakc-arib" "$work/recpt1" "$work/recdvb" /opt/mirakc/bin/
install -m 0644 "$work/strings.yml" /etc/mirakc/
install -m 0600 "$work/config.yml" /etc/mirakc/config.yml
cat > /etc/systemd/system/mirakc.service <<'UNIT'
[Unit]
Description=mirakc tuner server
After=network.target

[Service]
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/opt/mirakc/bin
Environment=TZ=Asia/Tokyo
Environment=RUST_LOG=info
ExecStart=/opt/mirakc/bin/mirakc -c /etc/mirakc/config.yml
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl start mirakc.service
for ((attempt=0; attempt<20; attempt++)); do
    if curl -fsS --max-time 2 http://127.0.0.1:40772/api/version 2>/dev/null; then
        printf '\n'
        systemctl enable mirakc.service
        exit 0
    fi
    sleep 1
done
systemctl stop mirakc.service
echo 'mirakc did not respond. Check journalctl -u mirakc -n 50.' >&2
exit 1
