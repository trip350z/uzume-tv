import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export function validRecordedFormat(value) {
    return typeof value === 'string' && value.length <= 240 &&
        !/[\\/<>:"|?*\x00-\x1f]/.test(value) &&
        !value.replace(/%(?:YEAR|MONTH|DAY|HOUR|MIN|SEC|DOW|TITLE|CHNAME|HALF_WIDTH_TITLE|HALF_WIDTH_CHNAME|ID)%/g, '').includes('%');
}

export function loadConfig(root, env = process.env, proposed) {
    const file = env.DVR_CONFIG ? resolve(env.DVR_CONFIG) : join(root, 'config.json');
    let config = {};
    try {
        config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
        if (error.code !== 'ENOENT' || env.DVR_CONFIG) throw new Error(file + ': ' + error.message);
    }
    if (proposed !== undefined) config = proposed;
    const invalid = (key, message) => { throw new Error(file + ' [' + key + '] ' + message); };
    if (!config || typeof config !== 'object' || Array.isArray(config)) invalid('JSON', '設定はオブジェクトで指定してください');
    function setting(key, fallback = null) {
        const value = config[key];
        if (value == null) return fallback;
        if (typeof value !== 'string' || !value.trim()) invalid(key, '空でない文字列または null を指定してください');
        return value.trim();
    }
    const port = Number(env.PORT ?? config.port ?? 8780);
    if (!Number.isInteger(port) || port < 1 || port > 65535) invalid('port', '1〜65535の整数を指定してください');
    const { epgInterval = 15, liveLimit = 4, recordingMinFreeGB = 10 } = config;
    if (typeof recordingMinFreeGB !== 'number' || !Number.isFinite(recordingMinFreeGB) ||
        recordingMinFreeGB < 0 || recordingMinFreeGB > 100000) {
        invalid('recordingMinFreeGB', '空き容量のしきい値を0〜100000 GBで指定してください（0で無効）');
    }
    if (!Number.isInteger(epgInterval) || epgInterval < 5 || epgInterval > 600) invalid('epgInterval', '5〜600秒の整数を指定してください');
    if (!Number.isInteger(liveLimit) || liveLimit < 1 || liveLimit > 16) invalid('liveLimit', '1〜16の整数を指定してください');
    let source = env.TUNER_URL ?? setting('tunerUrl');
    if (source) {
        let url;
        try { url = new URL(source); } catch { invalid('tunerUrl', 'HTTPまたはHTTPSのURLを指定してください'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
            invalid('tunerUrl', 'クエリや認証情報を含まないHTTPまたはHTTPSのベースURLを指定してください');
        }
        source = url.href.replace(/\/+$/, '');
    }
    const base = dirname(file);
    const dataDirectory = setting('dataDirectory');
    const directory = env.DVR_DATA ? resolve(env.DVR_DATA) : dataDirectory
        ? resolve(base, dataDirectory) : join(root, 'data', source ? 'recordings' : 'demo');
    function executable(value, baseDir) {
        return value && (isAbsolute(value) || /[/\\]/.test(value)) ? resolve(baseDir, value) : value;
    }
    const ffmpeg = env.FFMPEG ? executable(env.FFMPEG, process.cwd()) : executable(setting('ffmpeg', 'ffmpeg'), base);
    const nvencc = env.NVENCC !== undefined ? executable(env.NVENCC, process.cwd()) : executable(setting('nvencc'), base);
    const hidden = config.guideHiddenChannels ?? [];
    if (!Array.isArray(hidden) || hidden.some(id => !Number.isSafeInteger(id) || id < 1)) {
        invalid('guideHiddenChannels', '放送局IDを整数の配列で指定してください');
    }
    const destinations = new Map([['default', directory]]);
    const configured = config.recordingDirectories ?? {};
    if (typeof configured !== 'object' || Array.isArray(configured)) invalid('recordingDirectories', '保存先を名前とパスの組で指定してください');
    for (const [name, path] of Object.entries(configured)) {
        if (!name.trim() || name === 'default' || typeof path !== 'string' || !path.trim()) invalid('recordingDirectories', '保存先の名前とパスを確認してください');
        destinations.set(name, resolve(base, path));
    }
    const recordedFormat = config.recordedFormat ?? '';
    if (!validRecordedFormat(recordedFormat)) invalid('recordedFormat', 'ファイル名の文字と変数を確認してください');
    const qsvenc = executable(setting('qsvenc'), base);
    const vceenc = executable(setting('vceenc'), base);
    const commands = { ffmpeg, nvencc, qsvenc, vceenc };
    const profiles = new Map();
    const configuredProfiles = config.encodeProfiles ?? [];
    if (!Array.isArray(configuredProfiles)) invalid('encodeProfiles', 'プロファイルは配列で指定してください');
    for (const profile of configuredProfiles) {
        if (!profile || typeof profile.name !== 'string' || !profile.name.trim() ||
            profiles.has(profile.name) || !Object.hasOwn(commands, profile.encoder) || !commands[profile.encoder] ||
            !Array.isArray(profile.args) || profile.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
            invalid('encodeProfiles', '一意の名前、設定済みエンコーダー、引数の文字列配列を指定してください');
        }
        const prepare1080p30 = profile.prepare1080p30 ?? '';
        if (prepare1080p30 && (profile.encoder !== 'qsvenc' || !['1920:1080', '1280:720'].includes(prepare1080p30))) {
            invalid('encodeProfiles', 'QSVEncCの前処理解像度を確認してください');
        }
        profiles.set(profile.name, { encoder: profile.encoder, command: commands[profile.encoder], args: profile.args, prepare1080p30 });
    }
    const defaultEncodeProfile = config.defaultEncodeProfile ?? '';
    if (defaultEncodeProfile !== '' && !profiles.has(defaultEncodeProfile)) {
        invalid('defaultEncodeProfile', '登録済みのエンコードプロファイルを指定してください');
    }
    const liveProfiles = new Map();
    const configuredLiveProfiles = config.liveProfiles ?? [];
    if (!Array.isArray(configuredLiveProfiles) || configuredLiveProfiles.length > 32) {
        invalid('liveProfiles', 'ライブ用プロファイルは32件以内の配列で指定してください');
    }
    for (const profile of configuredLiveProfiles) {
        const { name, encoder, height, bitrate } = profile ?? {};
        if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 80 ||
            liveProfiles.has(name) || !Object.hasOwn(commands, encoder) || !commands[encoder] ||
            ![360, 480, 720, 1080].includes(height) || !Number.isInteger(bitrate) || bitrate < 300 || bitrate > 20000) {
            invalid('liveProfiles', '重複しない名前、設定済みエンコーダー、解像度、映像ビットレート（300〜20000 kbps）を指定してください');
        }
        liveProfiles.set(name, { encoder, height, bitrate, command: commands[encoder] });
    }
    const defaultLiveProfile = config.defaultLiveProfile ?? '';
    if (defaultLiveProfile !== '' && !liveProfiles.has(defaultLiveProfile)) {
        invalid('defaultLiveProfile', '登録済みのライブ用プロファイルを指定してください');
    }
    return { file, config, port, source, directory, ffmpeg, nvencc, destinations, profiles, defaultEncodeProfile, liveProfiles, defaultLiveProfile,
        epgInterval, liveLimit, recordingMinFreeGB, recordedFormat, guideHiddenChannels: new Set(hidden) };
}
