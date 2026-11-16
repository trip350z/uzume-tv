#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: sudo bash install-linux.sh [--tuner-url URL] [--port PORT] [--node PATH]
                                 [--encoder nvencc|qsvencc|vceencc]
                                 [--mirakc-config PATH] [--px4] [--arib-libs] [--recording-dir PATH]
Installs KreuzenTV and its software dependencies on Debian or Ubuntu with systemd.
Without --tuner-url, a new installation starts in demo mode.
--port defaults to 8781. Tuner URL and port apply to the initial setup only.
--node overrides automatic Node.js installation and must include npm.
--encoder installs a Linux GPU encoder package (amd64; compatible driver required).
--mirakc-config installs local mirakc from a prepared YAML configuration (amd64).
--px4 installs px4_drv and firmware for compatible tuners; requires --mirakc-config.
--arib-libs installs the three ARIB libraries; requires --mirakc-config.
--recording-dir sets the initial recording directory.
Interactive installs prompt for the encoder and recording directory if omitted.
EOF
}

die() { printf '%s\n' "$*" >&2; exit 1; }
tuner_url=
port=8781
node_path=
encoder=
mirakc_config=
recording_dir=
px4=false
arib_libs=false
while (($#)); do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --px4) px4=true; shift ;;
        --arib-libs) arib_libs=true; shift ;;
        --tuner-url|--port|--node|--encoder|--mirakc-config|--recording-dir)
            (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || die "Missing value for $1"
            case "$1" in
                --tuner-url) tuner_url=$2 ;;
                --port) port=$2 ;;
                --node) node_path=$2 ;;
                --encoder) encoder=$2 ;;
                --mirakc-config) mirakc_config=$2 ;;
                --recording-dir) recording_dir=$2 ;;
            esac
            shift 2 ;;
        *) die "Unknown argument: $1" ;;
    esac
done

[[ "$EUID" == 0 ]] || die 'Run this installer with sudo.'
source /etc/os-release
[[ "${ID:-}" == debian || "${ID:-}" == ubuntu ]] || die 'This installer requires Debian or Ubuntu.'
command -v apt-get >/dev/null || die 'This installer requires Debian or Ubuntu.'
[[ -d /run/systemd/system ]] || die 'Start Linux with systemd before installing.'
[[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && ((port <= 65535)) || die 'Invalid port.'
if { $px4 || $arib_libs; } && [[ -z "$mirakc_config" ]]; then die '--px4 and --arib-libs require --mirakc-config.'; fi
if [[ -t 0 && ! -e /etc/kreuzentv/config.json ]]; then
    if [[ -z "$encoder" ]]; then
        printf '%s\n' '1) FFmpeg (CPU)  2) NVEncC  3) QSVEncC  4) VCEEncC'
        while true; do
            read -r -p '使用するエンコーダー [1]: ' choice
            case "${choice:-1}" in
                1) encoder=ffmpeg; break ;;
                2) encoder=nvencc; break ;;
                3) encoder=qsvencc; break ;;
                4) encoder=vceencc; break ;;
            esac
            printf '%s\n' '1〜4を入力してください。' >&2
        done
    fi
    if [[ -z "$recording_dir" ]]; then
        read -r -p '既定の録画保存先 [/var/lib/kreuzentv]: ' recording_dir
    fi
fi
recording_dir=${recording_dir:-/var/lib/kreuzentv}
[[ "$recording_dir" == /* ]] || die 'Specify an absolute recording directory.'
recording_dir=$(realpath -m -- "$recording_dir")
[[ "$recording_dir" != / ]] || die 'Specify a recording directory other than /.'
case "$encoder" in
    ''|ffmpeg) encoder= ;;
    nvencc) encoder_repo=NVEnc; encoder_version=9.40; encoder_key=nvencc ;;
    qsvencc) encoder_repo=QSVEnc; encoder_version=8.37; encoder_key=qsvenc ;;
    vceencc) encoder_repo=VCEEnc; encoder_version=9.22; encoder_key=vceenc ;;
    *) die 'Invalid encoder. Choose nvencc, qsvencc or vceencc.' ;;
esac
arch=$(dpkg --print-architecture)
[[ -z "$encoder" || "$arch" == amd64 ]] || die 'The selected GPU encoder package requires amd64.'

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -n "$mirakc_config" ]]; then
    [[ -z "$tuner_url" ]] || die 'Specify either --mirakc-config or --tuner-url.'
    [[ -f "$mirakc_config" ]] || die 'Could not find the mirakc configuration.'
    [[ ! -e /etc/kreuzentv/config.json ]] || die 'Use install-mirakc.sh and then change the tuner URL in the existing KreuzenTV settings.'
    tuner_url=http://127.0.0.1:40772
fi
app_dir=/opt/kreuzentv
config_dir=/etc/kreuzentv
data_dir=/var/lib/kreuzentv
account=kreuzentv
unit=kreuzentv.service
files=(app.js index.html style.css manifest.webmanifest sw.js icon-192.png icon-512.png server.mjs config.mjs scheduling.mjs
    mariadb-state.mjs live-captions.mjs commercials.mjs)
for file in "${files[@]}" encode-profiles.json encode-profiles.hardware.example.json subtitle-tools/package.json subtitle-tools/package-lock.json; do
    [[ -f "$source_dir/$file" ]] || die "Keep the installer alongside the KreuzenTV source files. Missing: $file"
done

apt-get update
apt-get install -y ca-certificates curl xz-utils ffmpeg mariadb-server mariadb-client
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
chmod 0755 "$work"
download() {
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --retry 3 --connect-timeout 15 --output "$2" "$1"
}
node_ready() {
    [[ -n "$1" && -x "$1" && -x "$(dirname -- "$1")/npm" ]] &&
        "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'
}
if [[ -z "$node_path" ]]; then
    node_path="$app_dir/runtime/node/bin/node"
    if ! node_ready "$node_path"; then
        case "$arch" in
            amd64) node_arch=x64 ;;
            arm64) node_arch=arm64 ;;
            *) die 'Automatic Node.js installation supports amd64 and arm64. Use --node on other architectures.' ;;
        esac
        node_base=https://nodejs.org/dist/latest-v24.x
        download "$node_base/SHASUMS256.txt" "$work/SHASUMS256.txt"
        checksum=$(awk -v suffix="-linux-$node_arch.tar.xz" '$2 ~ (suffix "$") { print }' "$work/SHASUMS256.txt")
        [[ "$checksum" =~ ^[0-9a-f]{64}[[:blank:]]+node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] ||
            die 'Could not identify the Node.js archive.'
        archive=${checksum##* }
        version=${archive%-linux-*}
        download "https://nodejs.org/dist/${version#node-}/$archive" "$work/$archive"
        (cd "$work"; printf '%s\n' "$checksum" | sha256sum --check)
        install -d -m 0755 "$app_dir/runtime/node"
        tar --extract --xz --no-same-owner --strip-components=1 --directory="$app_dir/runtime/node" --file="$work/$archive"
    fi
fi
node_path=$(realpath -- "$node_path")
[[ "$node_path" =~ ^/[a-zA-Z0-9_./+-]+$ && -x "$node_path" ]] || die 'Use a system-wide Node.js executable with a path without spaces.'
node_ready "$node_path" || die 'Node.js 24 or later with npm is required.'

if [[ -n "$tuner_url" ]]; then
    "$node_path" --input-type=module -e 'const u = new URL(process.argv[1]); if (!["http:", "https:"].includes(u.protocol) || u.search || u.hash || u.username || u.password) process.exit(1)' -- "$tuner_url" ||
        die 'Specify an HTTP(S) tuner URL without credentials, query string or fragment.'
fi

if ! id "$account" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$data_dir" --shell /usr/sbin/nologin "$account"
fi
group=$(id -gn "$account")
runuser -u "$account" -- "$node_path" --version >/dev/null ||
    die 'Install Node.js in a location accessible to the kreuzentv service account.'

install -d -m 0755 "$app_dir" "$app_dir/logos"
install -d -o "$account" -g "$group" -m 0750 "$config_dir" "$data_dir"

subtitle_tools="$app_dir/subtitle-tools"
subtitle_cli=node_modules/aribb24.js/dist/cjs/runtime/cli/bin/ts2ass.js
if ! cmp -s "$source_dir/subtitle-tools/package-lock.json" "$subtitle_tools/package-lock.json" ||
    [[ ! -s "$subtitle_tools/$subtitle_cli" ]]; then
    install -d -m 0755 "$work/subtitle-tools"
    install -m 0644 "$source_dir/subtitle-tools/package.json" "$source_dir/subtitle-tools/package-lock.json" "$work/subtitle-tools/"
    chown "$account:$group" "$work/subtitle-tools"
    runuser -u "$account" -- env PATH="$(dirname "$node_path"):/usr/bin:/bin" \
        "$(dirname "$node_path")/npm" ci --ignore-scripts --no-audit --no-fund \
        --cache "$work/subtitle-tools/.npm" --prefix "$work/subtitle-tools"
    [[ -s "$work/subtitle-tools/$subtitle_cli" ]] || die 'ARIB subtitle CLI is missing.'
    install -d -m 0755 "$subtitle_tools"
    cp -R -- "$work/subtitle-tools/node_modules" "$subtitle_tools/"
    install -m 0644 "$work/subtitle-tools/package-lock.json" "$subtitle_tools/"
fi

comskip_ini=/usr/local/share/kreuzentv/comskip.ini
if ! command -v comskip >/dev/null; then
    comskip_source=https://codeload.github.com/erikkaashoek/Comskip/tar.gz/a140b6ac8bc8f596729e9052819affc779c3b377
    download "$comskip_source" "$work/comskip.tar.gz"
    install -d -o "$account" -g "$group" -m 0755 "$work/comskip"
    runuser -u "$account" -- tar -xzf "$work/comskip.tar.gz" --strip-components=1 -C "$work/comskip"
    apt-get install -y build-essential autoconf automake pkg-config libargtable2-dev \
        libavutil-dev libavformat-dev libavcodec-dev libswscale-dev
    (cd "$work/comskip"
        # FFmpeg 8 removed AVCodecContext.ticks_per_frame.
        if pkg-config --atleast-version=62 libavcodec; then
            runuser -u "$account" -- sed -i \
                -e '/if (codecCtx->codec_id == AV_CODEC_ID_MPEG1VIDEO)/{N;/ticks_per_frame = 1;/d;}' \
                -e 's/is->dec_ctx->ticks_per_frame/((is->dec_ctx->codec_id == AV_CODEC_ID_MPEG2VIDEO) ? 2 : 1)/g' mpeg2dec.c
        fi
        runuser -u "$account" -- sh ./autogen.sh
        runuser -u "$account" -- ./configure --disable-gui
        runuser -u "$account" -- make -j "$(nproc)"
    )
    install -m 0755 "$work/comskip/comskip" /usr/local/bin/comskip
fi
if [[ ! -f "$comskip_ini" ]]; then
    install -d -m 0755 "$(dirname "$comskip_ini")"
    printf 'output_edl=1\n' > "$comskip_ini"
fi

encoder_path=
encoder_key=${encoder_key:-}
if [[ -n "$encoder" ]]; then
    deb="${encoder}_${encoder_version}_amd64.deb"
    download "https://github.com/rigaya/$encoder_repo/releases/download/$encoder_version/$deb" "$work/$deb"
    apt-get install -y "$work/$deb"
    encoder_path=$(command -v "$encoder") || die "Installed package did not provide $encoder."
    for gpu_group in video render; do
        if getent group "$gpu_group" >/dev/null; then usermod -a -G "$gpu_group" "$account"; fi
    done
fi

if [[ ! -e "$config_dir/config.json" ]]; then
    if [[ ! -d "$recording_dir" ]]; then
        install -d -o "$account" -g "$group" -m 0750 -- "$recording_dir"
    fi
    runuser -u "$account" -- test -w "$recording_dir" &&
        runuser -u "$account" -- test -x "$recording_dir" ||
        die "Grant kreuzentv write and traversal access to $recording_dir."
    if [[ -n "$mirakc_config" ]]; then
        mirakc_args=("$mirakc_config")
        if $px4; then mirakc_args=(--px4 "${mirakc_args[@]}"); fi
        if $arib_libs; then mirakc_args=(--arib-libs "${mirakc_args[@]}"); fi
        bash "$source_dir/install-mirakc.sh" "${mirakc_args[@]}"
    fi
    "$node_path" --input-type=module -e '
        import { readFileSync, writeFileSync } from "node:fs";
        const [path, url, port, directory, encoder, executable, source] = process.argv.slice(1);
        const config = { port: Number(port), tunerUrl: url || null, dataDirectory: directory,
            ffmpeg: "/usr/bin/ffmpeg", nvencc: null, guideHiddenChannels: [] };
        if (encoder) config[encoder] = executable;
        config.encodeProfiles = ["encode-profiles.json", "encode-profiles.hardware.example.json"]
            .flatMap(file => JSON.parse(readFileSync(source + "/" + file, "utf8")))
            .filter(profile => profile.encoder === "ffmpeg" || profile.encoder === encoder);
        if (encoder) {
            const matching = config.encodeProfiles.filter(profile => profile.encoder === encoder);
            config.defaultEncodeProfile = (matching.find(profile => profile.prepare1080p30 === "1920:1080") ?? matching[0])?.name ?? "";
        }
        writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o640 });
    ' "$config_dir/config.json" "$tuner_url" "$port" "$recording_dir" "$encoder_key" "$encoder_path" "$source_dir"
    chown "$account:$group" "$config_dir/config.json"
fi
port=$("$node_path" --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const [source, app, config] = process.argv.slice(1);
    const { loadConfig } = await import(pathToFileURL(source + "/config.mjs"));
    console.log(loadConfig(app, { DVR_CONFIG: config }).port);
' "$source_dir" "$app_dir" "$config_dir/config.json")

if ! systemctl is-active --quiet "$unit"; then
    "$node_path" --input-type=module -e 'import { createServer } from "node:net"; createServer().listen(Number(process.argv[1]), "127.0.0.1", function () { this.close(); })' "$port" ||
        die "Port $port is in use. Set an available port in $config_dir/config.json."
fi

systemctl enable --now mariadb.service
mariadb --protocol=socket <<'SQL'
CREATE DATABASE IF NOT EXISTS kreuzentv CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'kreuzentv'@'localhost' IDENTIFIED VIA unix_socket;
GRANT CREATE, SELECT, INSERT, UPDATE ON kreuzentv.* TO 'kreuzentv'@'localhost';
SQL
runuser -u "$account" -- mariadb --protocol=socket kreuzentv -e 'SELECT 1' >/dev/null

for file in "${files[@]}"; do
    install -m 0644 -- "$source_dir/$file" "$app_dir/$file.new"
    mv -f -- "$app_dir/$file.new" "$app_dir/$file"
done
cat > "/etc/systemd/system/$unit" <<EOF
[Unit]
Description=KreuzenTV recorder
After=network-online.target mariadb.service
Wants=network-online.target
Requires=mariadb.service

[Service]
User=$account
Group=$group
WorkingDirectory=$app_dir
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=DVR_CONFIG=$config_dir/config.json
Environment=DVR_MARIADB_DATABASE=kreuzentv
Environment=DVR_RESTART_ON_APPLY=1
ExecStart=$node_path $app_dir/server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$unit"
if systemctl is-active --quiet "$unit"; then
    printf 'Files updated. To apply after recording or encoding finishes: sudo systemctl restart %s\n' "$unit"
else
    systemctl start "$unit"
    for ((attempt=0; attempt<45; attempt++)); do
        if systemctl is-active --quiet "$unit" &&
            curl -fsS --max-time 2 "http://127.0.0.1:$port/api/state" >/dev/null 2>&1; then
            printf 'KreuzenTV: http://127.0.0.1:%s/\n' "$port"
            exit 0
        fi
        sleep 1
    done
    die "KreuzenTV did not respond. Check: journalctl -u $unit -n 50"
fi
