#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 1 && $1 == --help ]]; then
    echo 'Usage: sudo bash install-mirakc.sh [--px4] [--arib-libs] /path/to/mirakc/config.yml'
    exit 0
fi
px4=false
arib_libs=false
while [[ ${1:-} == --px4 || ${1:-} == --arib-libs ]]; do
    case "$1" in
        --px4) px4=true ;;
        --arib-libs) arib_libs=true ;;
    esac
    shift
done
[[ $# -eq 1 && -f $1 && $EUID -eq 0 ]] || {
    echo 'Specify a mirakc YAML configuration and run with sudo.' >&2
    exit 1
}
[[ -d /run/systemd/system && $(dpkg --print-architecture) == amd64 ]]
if [[ -e /etc/mirakc/config.yml || -e /etc/systemd/system/mirakc.service ]]; then
    echo 'mirakc is already configured. Use --tuner-url with install-linux.sh to connect to it.' >&2
    exit 1
fi
if ss -H -ltn 'sport = :40772' | grep -q .; then
    echo 'Port 40772 is in use. Stop the previous tuner server before migrating.' >&2
    exit 1
fi

apt-get update
apt-get install -y ca-certificates curl docker.io python3-yaml kmod
systemctl start docker.service
# Use the same image as the Ubuntu deployment. Docker is used to extract the binaries.
image=docker.io/mirakc/mirakc@sha256:bcbf20b211e9a33666797f0a5f3af7b14d9a47ccefd4182f242b0a05a5c0ed82
work=$(mktemp -d)
container=
cleanup() {
    if [[ -n $container ]]; then docker rm "$container" >/dev/null || true; fi
    rm -rf -- "$work"
}
trap cleanup EXIT
if $arib_libs; then
    apt-get install -y build-essential autoconf automake libtool cmake pkg-config libpcsclite-dev pcscd
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
        ldconfig
    done
    systemctl start pcscd.socket
fi
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
if $px4; then
    if ! modinfo px4_drv >/dev/null 2>&1; then
        apt-get install -y "linux-headers-$(uname -r)" dkms
        package=px4-drv-dkms_0.7.1_all.deb
        curl -fsSL --retry 3 "https://github.com/tsukumijima/px4_drv/releases/download/v0.7.1/$package" -o "$work/$package"
        apt-get install -y "$work/$package"
    fi
    modprobe px4_drv
    udevadm settle
fi

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

python3 - "$1" "$work/config.yml" "$pt3" "$arib_libs" <<'PY'
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
        if any(re.search(rf"(?:--dev(?:\s+|=)){adapter}(?=\s|$)", tuner.get("command", "")) for tuner in tuners):
            continue
        tuners.append({"name": f"PT3 adapter{adapter}", "types": ["GR"] if terrestrial else ["BS", "CS"],
                       "command": f"/opt/mirakc/bin/recdvb --dev {adapter} " + "{{{channel}}} - -"})
    if not detected:
        raise SystemExit("PT3 was detected but earth_pt3 did not expose any DVB frontends.")
    print("PT3 DVB adapters: " + ", ".join(detected))
if not tuners:
    raise SystemExit("Configure tuner commands in the mirakc YAML first.")
if sys.argv[4] == "true":
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
