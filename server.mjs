import http from 'node:http';
import { isIPv4 } from 'node:net';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { chmodSync, createReadStream, createWriteStream, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { readdir, statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Readable, PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fitsTuners, matchesRule, predictConflicts, reservationOrder, ruleServices } from './scheduling.mjs';
import { loadConfig, validRecordedFormat } from './config.mjs';
import { reclaimRecordingSpace } from './storage-cleanup.mjs';
import { mariaDbStore } from './mariadb-state.mjs';
import { readLiveCaptions } from './live-captions.mjs';
import { parseCommercials, commercialFilters, cutCaptions, hasAmatsukazeLogoData, joinLogoCuts, logoPreview } from './commercials.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const { file: configFile, port, source, directory, ffmpeg, nvencc, destinations, profiles, defaultEncodeProfile, liveProfiles, defaultLiveProfile, epgInterval, liveLimit, recordingStartMarginSeconds, recordingMinFreeGB, recordedFormat, guideHiddenChannels } = loadConfig(root);
const encoderNames = { ffmpeg: 'FFmpeg', nvencc: 'NVEncC', qsvenc: 'QSVEncC', vceenc: 'VCEEncC' };
const liveProfileOptions = [...liveProfiles].map(([name, profile]) => ({ name, encoder: encoderNames[profile.encoder] }));
const isHidden = service => guideHiddenChannels.has(service);
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
mkdirSync(directory, { recursive: true });
const database = join(directory, 'dvr.json');
const store = process.env.DVR_MARIADB_DATABASE ? mariaDbStore(process.env.DVR_MARIADB_DATABASE) : null;
function loadJson() {
    try { return JSON.parse(readFileSync(database, 'utf8')); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return { reservations: [], rules: [] };
    }
}
const state = store ? store.load(loadJson) : loadJson();
function save() {
    if (store) {
        try { store.save(state); }
        catch (error) {
            console.error('MariaDBへの予約保存に失敗しました:', error.message);
            process.exit(1);
        }
        return;
    }
    writeFileSync(database + '.tmp', JSON.stringify(state, null, 2));
    renameSync(database + '.tmp', database);
}
const active = new Map();
let applyingSettings = false;
const canApplySettings = process.env.DVR_RESTART_ON_APPLY === '1';
const shareMediaFiles = process.env.DVR_SHARE_MEDIA_FILES === '1';
const lanAddress = process.env.DVR_LAN_ADDRESS;
if (lanAddress && (!isIPv4(lanAddress) || lanAddress === '0.0.0.0' || lanAddress.startsWith('127.'))) {
    throw new Error('DVR_LAN_ADDRESS にLANインターフェースのIPv4アドレスを指定してください');
}
const allowedHosts = new Set(['127.0.0.1:' + port, 'localhost:' + port]);
if (lanAddress) allowedHosts.add(lanAddress + ':' + port);
const proxyUrls = new Map();
for (const value of (process.env.DVR_PROXY_URL || '').split(',').map(value => value.trim()).filter(Boolean)) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search ||
        url.hash || !url.pathname.endsWith('/') || proxyUrls.has(url.host)) {
        throw new Error('DVR_PROXY_URL にホストごとに末尾が / の公開URLを指定してください');
    }
    proxyUrls.set(url.host, url);
}
const settingsInstance = randomUUID();
const liveSessions = new Map();
const hlsSessions = new Map();
const encoding = new Set();
const thumbnails = new Map();
let thumbnailQueue = Promise.resolve();
const thumbnailPath = row => join(directory, 'thumbnails', row.id + '.jpg');
const captionPath = row => join(directory, 'captions', row.id + '.vtt');
const captionJobs = new Map();
const exec = promisify(execFile);
function storagePath(destination, name) {
    const base = destinations.get(destination);
    if (!base || typeof name !== 'string' || name.length > 4096 ||
        (name && name.split('/').some(part => !part || part === '.' || part === '..' || /[\\:\0]/.test(part)))) return null;
    try {
        const root = realpathSync(base);
        const path = realpathSync(join(root, name));
        const location = relative(root, path);
        return isAbsolute(location) || location === '..' || location.startsWith('..' + sep) ? null : path;
    } catch { return null; }
}
function importedSourcePath(item) {
    const path = storagePath(item.destination, item.name);
    if (!path || path !== item.path) return null;
    try {
        const stats = statSync(path, { bigint: true });
        if (stats.isFile() && String(stats.ino) === item.inode) return path;
    } catch { /* The file may have been removed since registration. */ }
    return null;
}
const editedVideoPath = row => join(directory, 'imported-edits', row.id + '.mp4');
function recordingPath(row, format = 'ts') {
    const item = row.importedVideo;
    if (!item) return join((format === 'mp4' ? row.mp4Directory : row.tsDirectory) || directory,
        (row.fileStem || row.id) + '.' + format);
    if (format === 'mp4' && fileSize(editedVideoPath(row))) return editedVideoPath(row);
    return format === item.format ? importedSourcePath(item) : null;
}
const commercialSource = row => row.importedVideo ? importedSourcePath(row.importedVideo) : recordingPath(row);
for (const row of state.reservations) {
    if (row.status === 'recording') Object.assign(row, { status: 'failed', error: '録画中にサーバーが停止しました' });
}
save();

let services = [];
let serviceMap = new Map();
let tuners = null;
let programs = [];
let syncedAt = null;
let syncError = '';
let refreshing;
async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
        try {
            let nextServices, nextPrograms, nextTuners;
            if (source) {
                const get = async endpoint => {
                    const response = await fetch(source + '/api/' + endpoint, { signal: AbortSignal.timeout(15_000) });
                    if (!response.ok) throw new Error(endpoint + ' HTTP ' + response.status);
                    const data = await response.json();
                    if (!Array.isArray(data)) throw new Error(endpoint + ' の応答形式が不正です');
                    return data;
                };
                [nextServices, nextPrograms, nextTuners] = await Promise.all([
                    get('services'), get('programs'), get('tuners').catch(() => null)
                ]);
            } else {
                const halfHour = 1_800_000;
                const first = Math.floor(Date.now() / halfHour) - 2;
                nextServices = ['総合テレビ', '教育テレビ', 'みらいテレビ', '東都放送', 'BSスタジオ'].map((name, i) => ({
                    id: i + 1, networkId: 0, serviceId: i + 1, name, channel: { type: i === 4 ? 'BS' : 'GR', channel: String(i + 1) }
                }));
                nextPrograms = nextServices.flatMap((channel, c) => Array.from({ length: 340 }, (_, slot) => ({
                    id: (first + slot) * 10 + channel.id, networkId: 0, serviceId: channel.id,
                    startAt: (first + slot) * halfHour, duration: halfHour,
                    name: ['今日のニュース', '旅する日本', '連続ドラマ 風の便り', 'スポーツダイジェスト', '音楽の時間', '週末スタジオ', '名画シアター', '星空アニメ'][((first + slot + c * 3) % 8)],
                    description: '操作確認用のサンプル番組です。',
                    genres: [{ lv1: [0, 8, 3, 1, 4, 5, 6, 7][(first + slot + c * 3) % 8] }]
                })));
                nextTuners = [{ types: ['GR', 'BS'] }, { types: ['GR'] }];
            }
            const ids = new Map(nextServices.map(s => [s.networkId + '/' + s.serviceId, s.id]));
            const updated = nextPrograms.map(p => ({
                id: p.id, service: ids.get(p.networkId + '/' + p.serviceId),
                start: p.startAt, end: p.startAt + p.duration, title: p.name || '番組名未定',
                description: p.description || '',
                genres: p.genres?.map(genre => genre.lv1) || [],
                genreDetails: p.genres?.filter(genre => Number.isInteger(genre.lv2))
                    .map(({ lv1, lv2 }) => ({ lv1, lv2 })) || [],
                networkId: p.networkId, serviceId: p.serviceId, eventId: p.eventId,
                relays: p.relatedItems?.filter(item => item.type === 'relay') || []
            })).filter(p => Number.isSafeInteger(p.id) && p.service !== undefined &&
                Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start).sort((a, b) => a.start - b.start);
            services = nextServices;
            serviceMap = new Map(services.map(s => [s.id, s]));
            tuners = nextTuners?.filter(tuner => Array.isArray(tuner.types) && !tuner.isFault && tuner.isAvailable !== false) ?? null;
            programs = updated;
            syncedAt = Date.now();
            syncError = '';
            reconcile();
        } catch (error) {
            syncError = error.message;
            console.error('番組表の更新:', error.message);
        }
    })();
    try { await refreshing; } finally { refreshing = null; }
}

function addReservation(program, rule = null, relayOf = null, options = {}) {
    const { service, start, end, title, description } = program;
    const row = { id: randomUUID(), programId: program.id, service, start, end, title, description,
        status: 'scheduled', rule, relayOf, createdAt: Date.now() };
    applyRecordingOptions(row, options);
    state.reservations.push(row);
    return row;
}
function applyRecordingOptions(row, options) {
    const { start, title, service } = row;
    row.options = options;
    delete row.fileStem;
    const tsBase = destinations.get(options.destination) || directory;
    const mp4Base = destinations.get(options.encodeDestination) || tsBase;
    row.tsDirectory = join(tsBase, options.subDirectory || '');
    row.mp4Directory = join(mp4Base, options.subDirectory || '');
    const template = options.fileName === 'id' || options.fileName === 'title' ? '' : options.recordedFormat || recordedFormat;
    if (template) {
        const jst = new Date(start + 9 * 3_600_000);
        const [year, month, day, hour, minute, second] = jst.toISOString().slice(0, 19).split(/[-T:]/);
        const name = serviceMap.get(service)?.name || String(service);
        const values = { YEAR: year, MONTH: month, DAY: day, HOUR: hour, MIN: minute, SEC: second,
            DOW: '日月火水木金土'[jst.getUTCDay()], TITLE: title, CHNAME: name,
            HALF_WIDTH_TITLE: title.normalize('NFKC'), HALF_WIDTH_CHNAME: name.normalize('NFKC'), ID: row.id };
        const safe = template.replace(/%([A-Z_]+)%/g, (_, key) => values[key])
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '');
        const stem = [...safe].slice(0, 55).join('').replace(/[. ]+$/, '');
        if (stem) {
            row.fileStem = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(stem) ? '_' + stem : stem;
            const paths = [recordingPath(row), recordingPath(row, 'mp4')].map(path => path.toLowerCase());
            const taken = state.reservations.some(existing => existing.id !== row.id && ['ts', 'mp4'].some(format =>
                paths.includes(recordingPath(existing, format)?.toLowerCase())));
            if (taken || fileSize(recordingPath(row)) || fileSize(recordingPath(row, 'mp4'))) row.fileStem += '_' + row.id;
        }
    } else if (options.fileName === 'title') {
        const safeTitle = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
        row.fileStem = row.id + '_' + [...safeTitle].slice(0, 50).join('');
    }
}
function episodeKey(program) {
    const title = program.title?.trim();
    const description = program.description?.trim();
    if (!title || !description) return null;
    const episode = /(?:#\s*([0-9]+)|第\s*([0-9]+)\s*[話回])/.exec(title.normalize('NFKC')) ??
        /^(?:#\s*([0-9]+)|第\s*([0-9]+)\s*[話回])/.exec(description.normalize('NFKC'));
    return episode ? JSON.stringify([title, episode[1] ?? episode[2], description]) : null;
}

function reconcile() {
    const now = Date.now();
    const latest = new Map(programs.map(p => [p.id, p]));
    const existing = new Map(state.reservations.map(r => [r.programId, r]));
    const events = new Map(programs.filter(p => Number.isInteger(p.eventId)).map(p => [
        `${p.networkId}/${p.serviceId}/${p.eventId}`, p
    ]));
    let changed = false;
    for (const row of state.reservations) {
        if (!['scheduled', 'recording', 'completed', 'demo'].includes(row.status)) continue;
        const p = latest.get(row.programId);
        if (!p) continue;
        if (['scheduled', 'recording'].includes(row.status) && ['start', 'end', 'title'].some(key => row[key] !== p[key])) {
            if (row.end !== p.end) row.scheduleChanged = true;
            Object.assign(row, { start: p.start, end: p.end, title: p.title });
            changed = true;
        }
        if (isHidden(row.service)) continue;
        for (const link of p.relays) {
            const key = `${link.networkId ?? p.networkId}/${link.serviceId ?? p.serviceId}/${link.eventId}`;
            const target = events.get(key);
            if (!target || isHidden(target.service) || target.start < p.start ||
                target.end <= Math.max(p.end, now) || existing.has(target.id)) continue;
            existing.set(target.id, addReservation(target, row.rule, row.id, row.options));
            changed = true;
        }
    }
    const visiblePrograms = programs.filter(p => !isHidden(p.service));
    const episodeKeys = new Set();
    const suppressDuplicates = state.rules.some(rule => rule.enabled && rule.skipDuplicateEpisodes);
    if (suppressDuplicates) {
        for (const row of state.reservations) {
            if (row.importedVideo || !['scheduled', 'recording', 'completed'].includes(row.status) ||
                (row.status === 'scheduled' && (isHidden(row.service) || row.end <= now))) continue;
            const key = episodeKey(row);
            if (key) episodeKeys.add(key);
        }
    }
    const chronologicalPrograms = suppressDuplicates ? [...visiblePrograms].sort((a, b) => a.start - b.start) : visiblePrograms;
    for (const rule of state.rules) {
        if (!rule.enabled) continue;
        for (const p of rule.skipDuplicateEpisodes ? chronologicalPrograms : visiblePrograms) {
            if (p.start < now || existing.has(p.id) || !matchesRule(rule, p, serviceMap.get(p.service)?.channel?.type)) continue;
            const key = suppressDuplicates ? episodeKey(p) : null;
            if (rule.skipDuplicateEpisodes && key && episodeKeys.has(key)) continue;
            existing.set(p.id, addReservation(p, rule.id, null, rule.options));
            if (key) episodeKeys.add(key);
            changed = true;
        }
    }
    if (changed) save();
}

let spaceCleanup = null;
async function ensureRecordingSpace(location) {
    if (!recordingMinFreeGB) return;
    while (spaceCleanup) await spaceCleanup;
    spaceCleanup = (async () => {
        const candidates = state.reservations
            .filter(row => row.status === 'completed' && !row.importedVideo)
            .map(row => ({ id: row.id, start: row.start, ts: recordingPath(row), mp4: recordingPath(row, 'mp4') }));
        const busy = id => !state.reservations.some(row => row.id === id && row.status === 'completed') ||
            active.has(id) || encoding.has(id) || automaticEdits.has(id) || thumbnails.has(id) ||
            captionJobs.has(id) || logoExtractions.get(id)?.status === 'running' ||
            commercialJobs.get(id)?.status === 'running' ||
            [...liveSessions.values()].some(session => session.recordingId === id);
        await reclaimRecordingSpace(location, BigInt(Math.ceil(recordingMinFreeGB * 1e9)), candidates,
            async file => {
                const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries',
                    'format=duration:stream=codec_type', '-of', 'json', file], { timeout: 15000 });
                const info = JSON.parse(stdout);
                return Number(info.format?.duration) > 0 && info.streams?.some(stream => stream.codec_type === 'video');
            }, busy);
    })().catch(error => console.warn('録画先の空き容量を確認できませんでした', location, error.message));
    try { await spaceCleanup; }
    finally { spaceCleanup = null; }
}

async function record(row) {
    const controller = new AbortController();
    let created = false;
    active.set(row.id, controller);
    try {
        if (!source) {
            row.status = 'demo';
            return;
        }
        row.status = 'recording';
        save();
        mkdirSync(row.tsDirectory || directory, { recursive: true });
        await ensureRecordingSpace(row.tsDirectory || directory);
        let response;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const connection = new AbortController();
            const startup = setTimeout(() => connection.abort(), 30_000);
            try {
                response = await fetch(source + '/api/services/' + row.service + '/stream', {
                    signal: AbortSignal.any([controller.signal, connection.signal]),
                    headers: { 'X-Mirakurun-Priority': '2' }
                });
                if (response.ok && response.body) break;
                await response.body?.cancel();
                throw Object.assign(new Error('チューナー HTTP ' + response.status), { status: response.status });
            } catch (error) {
                controller.signal.throwIfAborted();
                const detail = connection.signal.aborted ? '応答タイムアウト' : error.cause?.code || error.message;
                console.warn('録画配信の接続失敗:', row.id, row.service, attempt, detail);
                if (attempt === 3 || error.status && error.status < 500 && ![408, 429].includes(error.status)) {
                    throw new Error('チューナー配信に接続できません: ' + detail);
                }
                await delay(attempt * 2000, undefined, { signal: controller.signal });
            } finally {
                clearTimeout(startup);
            }
        }
        const output = createWriteStream(recordingPath(row), { flags: 'wx' });
        output.once('open', () => { created = true; });
        await pipeline(Readable.fromWeb(response.body), output);
        if (!fileSize(recordingPath(row))) throw new Error('映像データを受信できませんでした');
        if (Date.now() < row.end) throw new Error('番組終了前にチューナーの配信が切断されました');
        row.status = 'completed';
    } catch (error) {
        const size = fileSize(recordingPath(row));
        if (controller.signal.reason === 'end' && size > 0) row.status = 'completed';
        else if (controller.signal.reason !== 'cancel') {
            row.status = 'failed';
            row.error = controller.signal.reason === 'timeout' ? 'チューナー接続がタイムアウトしました' : error.message;
        }
    } finally {
        if (created && shareMediaFiles) {
            try { chmodSync(recordingPath(row), 0o666); }
            catch (error) { console.error('録画ファイルの共有権限を設定できませんでした:', error.message); }
        }
        active.delete(row.id);
        save();
    }
}
let ticking = false;
async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        const atBoundary = state.reservations.some(r => active.has(r.id) && r.end <= Date.now());
        if (source && atBoundary && Date.now() - syncedAt > 2_000) await refresh();
        scheduleDue();
    } finally { ticking = false; }
}
function scheduleDue() {
    if (applyingSettings) return;
    const now = Date.now();
    let missed = false;
    for (const row of state.reservations) {
        if (active.has(row.id) && row.end <= now) active.get(row.id).abort('end');
    }
    const recording = state.reservations.filter(row => active.has(row.id)).map(row => row.service);
    const due = state.reservations.filter(row => row.status === 'scheduled' && row.start - recordingStartMarginSeconds * 1000 <= now).sort(reservationOrder);
    for (const row of due) {
        if (isHidden(row.service)) {
            if (row.end <= now) {
                Object.assign(row, { status: 'cancelled', error: '放送局が非表示設定のため録画を見送りました' });
                missed = true;
            }
            continue;
        }
        if (row.end <= now) {
            Object.assign(row, { status: 'failed', error: row.waitedForTuner
                ? 'チューナーの競合により録画できませんでした' : '予約時間内に録画を開始できませんでした' });
            missed = true;
        } else if (!fitsTuners([...recording, row.service], serviceMap, tuners)) {
            if (!row.waitedForTuner) {
                row.waitedForTuner = true;
                missed = true;
            }
        } else {
            const retained = [...recording, row.service];
            for (const session of liveSessions.values()) {
                if (fitsTuners([...retained, session.service], serviceMap, tuners)) retained.push(session.service);
                else session.stop();
            }
            if (row.waitedForTuner) row.partial = true;
            recording.push(row.service);
            void record(row);
        }
    }
    if (missed) save();
}
function fileSize(path) {
    if (!path) return 0;
    try { return statSync(path).size; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return 0; }
}
function removeFile(path) {
    try { unlinkSync(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function registeredVideo(path) {
    return state.reservations.some(row => (row.importedVideo && importedSourcePath(row.importedVideo) === path) ||
        ['ts', 'mp4'].some(format => {
        const current = recordingPath(row, format);
        if (!current) return false;
        try { return realpathSync(current) === path; }
        catch { return false; }
    }));
}

async function registerVideo(input) {
    const { destination, name, title } = input;
    const extension = typeof name === 'string' ? extname(name) : '';
    const type = extension.slice(1).toLowerCase();
    const format = type === 'm2ts' ? 'ts' : type;
    if (!['ts', 'mp4'].includes(format) || (title !== undefined &&
        (typeof title !== 'string' || title.trim().length > 250))) fail(400, '動画ファイルとタイトルを確認してください');
    const path = storagePath(destination, name);
    if (!path) fail(404, '動画ファイルが見つかりません');
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
    if (!stats?.isFile() || !stats.size) fail(404, '動画ファイルがありません');
    if (registeredVideo(path)) fail(409, 'このファイルは録画一覧に登録済みです');
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-f', format === 'ts' ? 'mpegts' : 'mov', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', path], { timeout: 15_000 })
        .catch(() => fail(422, '動画ファイルを読み取れませんでした'));
    const probe = JSON.parse(stdout);
    if (!probe.streams?.some(stream => stream.codec_type === 'video')) fail(422, '動画トラックが見つかりません');
    const duration = Number(probe.format?.duration);
    const importedVideo = { destination, name, format, path, inode: String(stats.ino) };
    const start = Number(stats.mtimeMs);
    const row = { id: randomUUID(), title: title?.trim() || basename(name, extension),
        status: 'completed', start, end: start + (Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : 0),
        description: '', importedVideo };
    if (!recordingPath(row, format)) fail(409, '動画ファイルが変更されました。選び直してください');
    if (registeredVideo(path)) fail(409, 'このファイルは録画一覧に登録済みです');
    state.reservations.push(row);
    save();
    return { id: row.id };
}
const nvVideoOptions = [...(process.platform === 'win32' ? ['--interlace', 'auto'] : []), '--vpp-yadif', 'mode=auto',
    '--codec', 'h264', '--vbr', '4500', '--bframes', '0', '--gop-len', '30', '--audio-codec', 'aac'];

const commercialJobs = new Map();
const automaticEdits = new Set();
const logoExtractions = new Map();
const extractingLogo = () => [...logoExtractions.values()].some(job => job.status === 'running');
setInterval(() => {
    for (const [id, job] of logoExtractions) {
        if (job.status !== 'running' && Date.now() - job.updated > 60 * 60 * 1000) logoExtractions.delete(id);
    }
}, 60_000).unref();
let batchEdit = null;

function startCommercialDetection(row) {
    const { id } = row;
    const input = commercialSource(row);
    const script = process.env.DVR_JLS_SCRIPT;
    const logoFolder = process.env.DVR_JLS_LOGOS;
    const generator = process.env.DVR_JLS_LOGO_GENERATOR;
    const logoEnabled = script && logoFolder && Number.isSafeInteger(row.service);
    const preferred = logoEnabled && (process.env.DVR_JLS_AMATSUKAZE ? stationLogo(row.service, true) || stationLogo(row.service) : stationLogo(row.service));
    let logo = preferred && registeredLogo(preferred);
    const job = { status: 'running', cuts: [], startedAt: Date.now(), progress: null, phase: 'detecting',
        detector: logo ? 'join_logo_scp' : 'Comskip' };
    commercialJobs.set(id, job);
    const finished = (async () => {
        const folder = join(directory, 'commercials');
        const edl = join(folder, id + '.edl');
        try {
            mkdirSync(folder, { recursive: true });
            if (!logo && logoEnabled && generator) {
                job.detector = 'join_logo_scp';
                job.phase = 'generating-logo';
                try {
                    logo = await generateStationLogo(input, logoFolder, row.service, generator);
                    job.logoGenerated = true;
                } catch (error) {
                    console.error('局ロゴ生成失敗:', row.service, error.code || error.message);
                    job.detector = 'Comskip';
                    job.logoGenerationFailed = true;
                    job.phase = 'detecting';
                }
            }
            const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,avg_frame_rate',
                '-of', 'json', input], { timeout: 15000 })).stdout);
            const duration = Number(probe.format.duration);
            if (!Number.isFinite(duration) || duration <= 0) throw new Error('録画の長さを取得できません');
            job.duration = duration;
            job.hasAudio = probe.streams.some(stream => stream.codec_type === 'audio');
            if (logo) {
                const [rate, divisor] = (probe.streams.find(stream => stream.codec_type === 'video')?.avg_frame_rate || '').split('/').map(Number);
                try {
                    job.cuts = await detectWithJoinLogo(input, logo, script, folder, job, rate / divisor, duration);
                } catch (error) {
                    if (!/マッチするロゴが見つかりませんでした|出力AVSファイルが不正|ロゴの拡張データ|failed to read value/i.test(error.message)) throw error;
                    console.warn('CM解析で局ロゴが一致しません:', row.id, row.service);
                    job.detector = 'Comskip';
                    if (error.message.includes('マッチするロゴが見つかりませんでした')) job.logoMismatch = true;
                    else job.logoAnalysisFailed = true;
                }
            }
            if (job.detector === 'Comskip') {
                job.phase = 'detecting';
                removeFile(edl);
                const detection = exec('comskip', ['--ini=/usr/local/share/uzume-tv/comskip.ini', '--output=' + folder, '--output-filename=' + id, input],
                    { timeout: 3600000, maxBuffer: 4194304, windowsHide: true });
                let pending = '';
                detection.child.stderr.on('data', chunk => {
                    const lines = (pending + chunk).split(/[\r\n]/);
                    pending = lines.pop().slice(-512);
                    for (const line of lines) {
                        const match = /fps\),\s*(\d{1,3})%\s*$/.exec(line);
                        if (match) job.progress = Math.max(job.progress ?? 0, Math.min(99, Number(match[1])));
                    }
                });
                await detection.catch(error => {
                    if (error.code !== 1) throw error;
                });
                job.cuts = (fileSize(edl) ? parseCommercials(readFileSync(edl, 'utf8')) : [])
                    .filter(cut => cut.end <= duration);
            }
            job.phase = 'checking';
            if (job.cuts.some((cut, index) => index && job.cuts[index - 1].end > cut.start) ||
                job.cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0) >= duration - 1) throw new Error('CM候補の時間範囲が不正です');
            job.status = 'ready';
        } catch (error) {
            job.status = 'failed';
            job.error = 'CM検出に失敗しました: ' + (error.code || error.message);
        }
    })();
    return { job, finished };
}

async function generateStationLogo(input, logoFolder, service, generator) {
    mkdirSync(logoFolder, { recursive: true });
    const work = mkdtempSync(join(logoFolder, '.scan-'));
    try {
        const output = join(work, 'station.lgd');
        await exec(generator, ['-i', input, '-o', output, '--auto-logo-detect-threads', '2'],
            { timeout: 1800000, maxBuffer: 4194304, windowsHide: true });
        if (!fileSize(output)) throw new Error('ロゴ生成結果が空です');
        const destination = join(logoFolder, service + '.lgd');
        const { link } = await import('node:fs/promises');
        await link(output, destination).catch(error => {
            if (error.code !== 'EEXIST') throw error;
        });
        if (!fileSize(destination)) throw new Error('保存済みの局ロゴが空です');
        return destination;
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}
function startLogoExtraction(row, input) {
    const generator = process.env.DVR_JLS_LOGO_GENERATOR;
    const folder = process.env.DVR_JLS_LOGOS;
    if (!generator || !folder) fail(409, 'ロゴ抽出ツールまたは保存先が設定されていません');
    if (extractingLogo() || automaticEdits.size || [...commercialJobs.values()].some(job => job.status === 'running')) {
        fail(409, '他のロゴ抽出またはCM解析が実行中です');
    }
    const { start = 0, region } = input;
    if (!Number.isSafeInteger(start) || start < 0 || start > 604800) fail(400, '抽出開始位置を確認してください');
    if (region != null) logoFilter(region);
    const source = commercialSource(row);
    if (!['completed', 'failed', 'cancelled'].includes(row.status) || active.has(row.id) || !fileSize(source)) {
        fail(409, '抽出元の動画がありません');
    }
    if (logoExtractions.size >= 8 && !logoExtractions.has(row.id)) logoExtractions.delete(logoExtractions.keys().next().value);
    const job = { token: randomUUID(), status: 'running', phase: '解析用の映像を準備中', updated: Date.now() };
    logoExtractions.set(row.id, job);
    void (async () => {
        let work;
        try {
            work = mkdtempSync(join(tmpdir(), 'uzume-tv-logo-'));
            const sample = join(work, 'sample.ts');
            const output = join(work, 'station.lgd');
            await exec(ffmpeg, ['-nostdin', '-v', 'error', '-ss', String(start), '-i', source, '-map', '0:v:0',
                '-t', '360', '-c:v', 'copy', '-f', 'mpegts', sample], { timeout: 180_000, windowsHide: true })
                .catch(() => fail(422, '解析用の映像を切り出せませんでした'));
            job.phase = '映像からロゴを抽出中';
            const extraction = exec(generator, ['-i', sample, '-o', output, '--auto-logo-detect-threads', '2',
                ...(region ? ['--logo-range', ['x', 'y', 'w', 'h'].map(key => region[key]).join(',')] : [])],
            { timeout: 1_800_000, maxBuffer: 4_194_304, windowsHide: true });
            for (const stream of [extraction.child.stdout, extraction.child.stderr]) {
                stream.on('data', chunk => {
                    for (const [, stage, value] of chunk.toString().matchAll(/(overall|progress)=(\d+(?:\.\d+)?)%/g)) {
                        const progress = region ? Number(value) :
                            stage === 'overall' ? Number(value) * .65 : 65 + Number(value) * .35;
                        job.progress = Math.max(job.progress ?? 0, Math.min(99, progress));
                    }
                });
            }
            await extraction.catch(error => {
                console.error('ロゴ抽出:', (error.stderr || error.message).trim().slice(-1600));
                const insufficient = /insufficient logo frames/i.test((error.stdout || '') + (error.stderr || ''));
                fail(422, insufficient ? 'ロゴが映るフレームが不足しています。開始位置や範囲を変えてください' :
                    'ロゴを抽出できませんでした。開始位置やロゴ範囲を変えてお試しください');
            });
            if (!fileSize(output) || fileSize(output) > 16 * 1024 * 1024) fail(422, 'ロゴデータを生成できませんでした');
            job.data = readFileSync(output);
            if (!hasAmatsukazeLogoData(job.data)) fail(422, '抽出ツールがAmatsukaze用の拡張データを出力しませんでした');
            job.preview = logoPreview(job.data);
            job.status = 'ready';
        } catch (error) {
            job.status = 'failed';
            job.error = error.message;
        } finally {
            job.updated = Date.now();
            if (work) {
                try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); }
                catch (error) { console.error('ロゴ抽出一時ファイル:', error.message); }
            }
        }
    })();
    return job;
}
function registerExtractedLogo(row, { service, token, replace = false }) {
    const job = logoExtractions.get(row.id);
    if (job?.status !== 'ready' || !job.data || job.token !== token) fail(409, '抽出結果が変わりました。画像を確認し直してください');
    if (!Number.isSafeInteger(service) || !serviceMap.has(service) ||
        (!row.importedVideo && row.service !== service) || typeof replace !== 'boolean') fail(400, '登録先の放送局を確認してください');
    if (stationLogo(service) && !replace) fail(409, 'この局には登録済みのLGDがあります');
    const folder = process.env.DVR_JLS_LOGOS;
    mkdirSync(folder, { recursive: true });
    const destination = join(folder, service + '.lgd');
    const temporary = join(folder, '.' + randomUUID() + '.tmp');
    try {
        writeFileSync(temporary, job.data, { flag: 'wx', mode: 0o644 });
        if (replace) renameSync(temporary, destination);
        else linkSync(temporary, destination);
    } catch (error) {
        if (error.code === 'EEXIST') fail(409, 'この局には登録済みのLGDがあります');
        throw error;
    } finally { removeFile(temporary); }
    delete job.data;
    delete job.preview;
    job.status = 'registered';
    job.updated = Date.now();
}

async function detectWithJoinLogo(input, logo, script, folder, job, fps, duration) {
    const work = mkdtempSync(join(folder, 'jls-'));
    try {
        const cli = process.env.DVR_JLS_AMATSUKAZE;
        if (cli) {
            if (!hasAmatsukazeLogoData(readFileSync(logo))) throw new Error('Amatsukaze用ロゴの拡張データがありません');
            job.phase = 'logo';
            const bin = join(cli, '..');
            const drcs = join(work, 'drcs');
            mkdirSync(drcs);
            await exec(cli, ['--mode', 'cm', '-i', input, '-o', join(work, 'output'), '-w', work,
                '--chapter', '--chapter-exe', join(bin, 'chapter_exe'), '--jls', join(bin, 'join_logo_scp'),
                '--tsreadex', join(bin, 'tsreadex'),
                '--jls-cmd', script, '--logo', logo, '--auto-logo-detect', '0', '--no-delogo',
                '--drcs', join(drcs, 'drcs_map.txt'), '--ignore-no-drcsmap', '--no-remove-tmp'],
            { cwd: bin, timeout: 1800000, maxBuffer: 4194304, windowsHide: true })
                .catch(error => {
                    const log = [error.stdout, error.stderr].join('\n');
                    throw new Error(log.split(/\r?\n/).filter(line => /Message:|\[error\]/.test(line)).slice(-2).join(' ') ||
                        'AmatsukazeCLI: ' + (error.code || error.message));
                });
            const trims = (await readdir(work, { recursive: true })).filter(file => /(?:^|[\\/])trim\d+\.avs$/i.test(file));
            if (trims.length !== 1) throw new Error('CM解析結果が単一のTrimファイルにまとまりませんでした');
            return joinLogoCuts(readFileSync(join(work, trims[0]), 'utf8'), fps, duration);
        }
        const avs = join(work, 'input.avs');
        const ts = join(work, 'recording.ts');
        const { symlink } = await import('node:fs/promises');
        await symlink(input, ts);
        writeFileSync(avs, 'v = LWLibavVideoSource("recording.ts", repeat=false)\n' +
            (job.hasAudio ? 'AudioDub(v, LWLibavAudioSource("recording.ts", av_sync=true))\n' : 'v\n'));
        const run = async (command, args) => exec(command, args, {
            cwd: work, timeout: 1800000, maxBuffer: 4194304, windowsHide: true
        }).catch(error => { throw new Error(command + ': ' + (error.stderr?.trim().slice(-300) || error.code || error.message)); });
        job.phase = 'chapters';
        await run('chapter_exe', ['-v', avs, '-s', '8', '-e', '4', '-o', 'chapters.txt']);
        job.phase = 'logo';
        await run('logoframe', [avs, '-oa', 'logo.txt', '-o', 'logo.avs', '-logo', logo]);
        job.phase = 'checking';
        await run('join_logo_scp', ['-inlogo', 'logo.txt', '-inscp', 'chapters.txt', '-incmd', script, '-o', 'keep.avs']);
        return joinLogoCuts(readFileSync(join(work, 'keep.avs'), 'utf8'), fps, duration);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}
function logoFilter(region) {
    if (region === undefined || region === null) return '';
    const keys = ['x', 'y', 'w', 'h'];
    if (typeof region !== 'object' || !keys.every(key =>
        Number.isSafeInteger(region[key]) && region[key] >= 2 && region[key] <= 8192)) {
        fail(400, 'ロゴ範囲は2以上の整数で指定してください');
    }
    return 'delogo=' + keys.map(key => key + '=' + region[key]).join(':');
}

function registeredLogo(name) {
    const folder = process.env.DVR_JLS_LOGOS;
    if (!folder || typeof name !== 'string' || !/^\d+\.lgd2?$/.test(name)) return null;
    const path = join(folder, name);
    return lstatSync(path, { throwIfNoEntry: false })?.isFile() ? path : null;
}
function supportsAmatsukazeLogo(name) {
    const file = registeredLogo(name);
    if (!file || fileSize(file) > 16 * 1024 * 1024) return false;
    try { return hasAmatsukazeLogoData(readFileSync(file)); }
    catch { return false; }
}
function stationLogo(service, amatsukaze = false) {
    return Number.isSafeInteger(service) && ['lgd', 'lgd2'].map(ext => service + '.' + ext)
        .find(amatsukaze ? supportsAmatsukazeLogo : registeredLogo);
}
function preferredEditLogo(row, profileName) {
    if (profiles.get((profileName || row.options?.encodeProfile) || defaultEncodeProfile)?.encoder !== 'qsvenc') return null;
    const native = process.env.DVR_JLS_AMATSUKAZE && stationLogo(row.service, true);
    if (native) return { lgd: native, engine: 'amatsukaze' };
    const lgd = stationLogo(row.service);
    return lgd ? { lgd } : null;
}

function editLogo(value) {
    if (value?.lgd === undefined) return logoFilter(value);
    const path = registeredLogo(value.lgd);
    if (!path || path.includes(',')) fail(400, '登録済みのLGDロゴを選択してください');
    const size = fileSize(path);
    if (size > 16 * 1024 * 1024) fail(422, 'ロゴデータが大きすぎます');
    let data, preview;
    try {
        data = readFileSync(path);
        preview = logoPreview(data);
    } catch { fail(422, 'LGDロゴを読み取れません'); }
    if (value.engine === 'amatsukaze' && !hasAmatsukazeLogoData(data)) {
        fail(422, 'このLGDにはAmatsukaze用の拡張データがありません。「ロゴを抽出」で再生成するか、LGD（QSVEncC）を選択してください');
    }
    const { count, x, y, width, height } = preview;
    return { lgd: path + (count > 1 ? ',select=1' : ''), x, y, width, height,
        ...(value.engine === 'amatsukaze' ? { amatsukaze: path } : {}) };
}

async function probeVideo(input) {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,sample_aspect_ratio,display_aspect_ratio,avg_frame_rate,duration,start_time,codec_name:format=duration,start_time',
        '-of', 'json', input], { timeout: 15000 })
        .catch(() => fail(422, '元動画の映像サイズを取得できません'));
    const { streams, format } = JSON.parse(stdout);
    const video = streams?.[0];
    if (!video) fail(422, '元動画の映像サイズを取得できません');
    return { video, format };
}
function qsvSourceAspect(video, profile) {
    const sar = video.sample_aspect_ratio;
    if (!/^[1-9]\d*:[1-9]\d*$/.test(sar ?? '') ||
        profile.args.some(value => /^--(?:sar|dar|output-res)(?:=|$)/.test(value))) return [];
    return ['--sar', sar];
}
function logoOutputSize(video, resolution) {
    if (!resolution) return [];
    const [maxWidth, maxHeight] = resolution.split(':').map(Number);
    const [x, y] = (video.display_aspect_ratio || '').split(':').map(Number);
    const ratio = x > 0 && y > 0 ? x / y : video.width / video.height;
    const even = value => Math.max(2, Math.round(value / 2) * 2);
    return ['--output-res', even(Math.min(maxWidth, maxHeight * ratio)) + 'x' +
        even(Math.min(maxHeight, maxWidth / ratio)), '--sar', '1:1'];
}
function amatsukazeProfileArgs(profile, video) {
    const args = [];
    for (let i = 0; i < profile.args.length; i++) {
        const value = profile.args[i];
        const key = value.split('=', 1)[0];
        if (['--avsw', '--avhw', '--y4m', '--raw'].includes(value)) continue;
        if (['--audio-codec', '--audio-bitrate', '--audio-samplerate', '--input-format'].includes(key)) {
            if (key === value) i++;
            continue;
        }
        if (!/^[\w.,:+/=-]+$/.test(value) || ['-i', '-o', '-f', '--input', '--output', '--output-format',
            '--vpp-delogo', '--trim', '--seek', '--frames'].includes(key)) {
            fail(400, 'このQSVEncCプロファイルにはAmatsukazeで利用できない引数があります');
        }
        args.push(value);
    }
    if (!args.some(value => value.startsWith('--vpp-yadif') || value.startsWith('--vpp-deinterlace') ||
        value.startsWith('--vpp-bwdif'))) args.push('--vpp-yadif', 'mode=auto');
    args.push(...(profile.prepare1080p30 ? logoOutputSize(video, profile.prepare1080p30) : qsvSourceAspect(video, profile)));
    return args.join(' ');
}
function amatsukazeTrim(cuts, video, format, frameCount) {
    const [n, d] = (video.avg_frame_rate || '').split('/').map(Number);
    const fps = n / d;
    const duration = Number(video.duration) || Number(format?.duration);
    if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(duration) || duration <= 0) fail(422, 'CMカット用の映像時間を取得できません');
    const offset = Math.max(0, (Number(video.start_time) - Number(format?.start_time)) || 0);
    const total = frameCount ?? Math.round(duration * fps);
    const sections = [];
    let cursor = 0;
    for (const { start, end } of cuts) {
        const first = Math.min(total, Math.max(0, Math.ceil((start - offset) * fps)));
        if (cursor < first) sections.push('Trim(' + cursor + ',' + (first - 1) + ')');
        cursor = Math.max(cursor, Math.ceil((end - offset) * fps));
    }
    if (cursor < total) sections.push('Trim(' + cursor + ',' + (total - 1) + ')');
    if (!sections.length) fail(422, 'CMカット後に残る映像がありません');
    return sections.join(' ++ ') + '\n';
}
async function amatsukazeFrameCount(bin, work) {
    const directories = (await readdir(work, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^amt\d+$/.test(entry.name));
    if (directories.length !== 1) throw new Error('Amatsukazeの映像フレーム数を特定できません');
    const folder = join(work, directories[0].name);
    const files = (await readdir(folder)).filter(name => /^amts\d+\.dat$/.test(name));
    if (files.length !== 1) throw new Error('Amatsukazeで分割された映像にはこのカット区間を適用できません');
    const reader = `
import ctypes as c, os, sys
lib = c.CDLL(sys.argv[1])
lib.AMTContext_Create.argtypes = []
lib.AMTContext_Create.restype = c.c_void_p
lib.ATMContext_Delete.argtypes = [c.c_void_p]
lib.TrimAdjust_Create.argtypes = [c.c_void_p, c.c_char_p, c.c_int]
lib.TrimAdjust_Create.restype = c.c_void_p
lib.TrimAdjust_GetNumFrames.argtypes = [c.c_void_p]
lib.TrimAdjust_Delete.argtypes = [c.c_void_p]
ctx = lib.AMTContext_Create()
try:
    source = lib.TrimAdjust_Create(ctx, os.fsencode(sys.argv[2]), 0)
    if not source:
        raise RuntimeError("Cannot read Amatsukaze source")
    try:
        print(lib.TrimAdjust_GetNumFrames(source))
    finally:
        lib.TrimAdjust_Delete(source)
finally:
    lib.ATMContext_Delete(ctx)
`;
    const { stdout } = await exec('python3', ['-c', reader, join(bin, 'libAmatsukaze.so'), join(folder, files[0])],
        { cwd: bin, timeout: 15000, windowsHide: true });
    const count = Number(stdout.trim().split(/\r?\n/).at(-1));
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Amatsukazeの実フレーム数を取得できません');
    rmSync(folder, { recursive: true, force: true });
    return count;
}
async function runAmatsukaze(row, input, output, cuts, logo, profile, metadata, encoderOptions) {
    const cli = process.env.DVR_JLS_AMATSUKAZE;
    const bin = dirname(cli);
    const work = mkdtempSync(join(dirname(output), '.amt-edit-'));
    try {
        let source = input;
        if (row.importedVideo) {
            source = join(work, 'source.ts');
            await exec(ffmpeg, ['-nostdin', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
                '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-f', 'mpegts', source],
            { timeout: 3_600_000, windowsHide: true });
        }
        const result = join(work, 'edited.mp4');
        const drcs = join(work, 'drcs');
        mkdirSync(drcs);
        const options = ['-i', source, '-o', result, '-w', work, '-fmt', 'mp4',
            '--tsreadex', join(bin, 'tsreadex'), '--mp4box', join(bin, 'MP4Box'), '-m', join(bin, 'muxer'),
            '-t', join(bin, 'timelineeditor'), '-et', 'QSVEnc', '-e', profile.command, '-eo', encoderOptions,
            '--logo', logo.amatsukaze, '--auto-logo-detect', '0', '--audio-format-change', 'merge',
            '--drcs', join(drcs, 'drcs_map.txt'), '--ignore-no-drcsmap'];
        const trim = join(work, 'trim.avs');
        const initialTrim = cuts.length ? amatsukazeTrim(cuts, metadata.video, metadata.format) : '';
        if (initialTrim) {
            writeFileSync(trim, initialTrim);
            options.push('--trimavs', trim, '--cmoutmask', '2', '--no-remove-tmp');
        }
        const execute = () => exec(cli, options, { cwd: bin, timeout: 21_600_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
            .catch(error => {
                const log = (error.stdout || '') + '\n' + (error.stderr || '');
                const details = log.split(/[\r\n]+/).filter(line => /Message:|\[error\]/.test(line)).slice(-3).join(' ');
                throw new Error('Amatsukaze: ' + (details || error.code || error.message));
            });
        try { await execute(); }
        catch (error) {
            if (!initialTrim || !error.message.includes('出力AVSファイルが不正')) throw error;
            const count = await amatsukazeFrameCount(bin, work);
            const corrected = amatsukazeTrim(cuts, metadata.video, metadata.format, count);
            if (corrected === initialTrim) throw error;
            writeFileSync(trim, corrected);
            await execute();
        }
        if (!fileSize(result)) throw new Error('Amatsukazeが単一の編集済みMP4を出力できませんでした');
        renameSync(result, output);
    } finally {
        rmSync(work, { recursive: true, force: true, maxRetries: 3 });
    }
}

async function encode(row, cuts = [], hasAudio = false, logo = '', { reencode = false, encodeProfile, fromOriginal = false } = {}) {
    if (encodeProfile !== undefined && typeof encodeProfile !== 'string') fail(400, 'エンコードプロファイルを選択してください');
    const profileName = (encodeProfile ?? row.options?.encodeProfile) || defaultEncodeProfile;
    const profile = profiles.get(profileName);
    if (profileName && !profile) fail(400, 'エンコードプロファイルが見つかりません: ' + profileName);
    const lgd = logo?.lgd;
    if (lgd && profile?.encoder !== 'qsvenc') fail(400, 'LGD方式ではQSVEncCのエンコードプロファイルを選択してください');
    if (logo?.amatsukaze && !process.env.DVR_JLS_AMATSUKAZE) fail(409, 'AmatsukazeCLIが設定されていません');
    if (lgd) fromOriginal = true;
    const output = row.importedVideo ? editedVideoPath(row) : recordingPath(row, 'mp4');
    const input = !fromOriginal && (reencode || (logo && !cuts.length)) && fileSize(output) ? output : commercialSource(row);
    if (!fileSize(input)) fail(404, '編集元の動画ファイルがありません');
    mkdirSync(dirname(output), { recursive: true });
    const temporary = output + '.part';
    const resolution = profile?.prepare1080p30;
    const filtered = cuts.length > 0 || Boolean(logo);
    const prepare = filtered || Boolean(resolution);
    encoding.add(row.id);
    let logoArgs = [], amt;
    try {
        if (lgd || (prepare && !resolution && profile?.encoder === 'qsvenc')) {
            const metadata = await probeVideo(input);
            const { video } = metadata;
            if (lgd && (logo.x < 0 || logo.y < 0 || logo.x + logo.width > video.width || logo.y + logo.height > video.height)) {
                fail(422, 'LGDロゴの位置が元動画の映像サイズを超えています');
            }
            if (logo.amatsukaze) {
                if (!['mpeg2video', 'h264', 'hevc'].includes(metadata.video.codec_name)) fail(422, 'Amatsukazeで扱える映像形式を選択してください');
                if (cuts.length) amatsukazeTrim(cuts, metadata.video, metadata.format);
                amt = { metadata, options: amatsukazeProfileArgs(profile, metadata.video) };
            } else logoArgs = [...(lgd ? ['--vpp-delogo', lgd] : []),
                ...(resolution ? logoOutputSize(video, resolution) : qsvSourceAspect(video, profile))];
        }
    }
    catch (error) { encoding.delete(row.id); throw error; }
    row.encodeError = '';
    save();
    if (amt) {
        void (async () => {
            try {
                await runAmatsukaze(row, input, temporary, cuts, logo, profile, amt.metadata, amt.options);
                if (shareMediaFiles) chmodSync(temporary, 0o666);
                renameSync(temporary, output);
                if (cuts.length) row.commercialCuts = cuts;
                else delete row.commercialCuts;
            } catch (error) {
                row.encodeError = error.message;
                removeFile(temporary);
            } finally {
                encoding.delete(row.id);
                save();
            }
        })();
        return;
    }
    const encoder = encoderNames[profile?.encoder] || (nvencc ? 'NVEncC' : 'FFmpeg');
    const bitrate = row.options?.quality === 'compact' ? '2200' : '4500';
    const filters = cuts.length ? commercialFilters(cuts, hasAudio) : ['-vf', 'yadif=deint=interlaced'];
    if (logo && !lgd) filters[1] = logo + ',' + filters[1];
    if (resolution) filters[1] += lgd ? ',fps=30' :
        ',fps=30,scale=' + resolution + ':force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1';
    const ffmpegInput = prepare ? ['-f', 'nut', '-i', 'pipe:0'] : ['-i', input];
    const args = profile ? (profile.encoder === 'ffmpeg'
        ? ['-nostdin', '-loglevel', 'error', '-y', ...ffmpegInput, ...profile.args, '-f', 'mp4', temporary]
        : [...(prepare ? ['--input-format', 'nut', '-i', '-'] : ['-i', input]), ...profile.args, ...logoArgs, '-f', 'mp4', '-o', temporary])
        : nvencc ? ['--avsw', ...(prepare ? ['--input-format', 'nut', '-i', '-'] :
            [...(input === output || row.importedVideo?.format === 'mp4' ? [] : ['--input-format', 'mpegts']), '-i', input]),
        ...nvVideoOptions.map((value, index) => nvVideoOptions[index - 1] === '--vbr' ? bitrate : value)
            .filter((value, index) => !prepare || !['--interlace', '--vpp-yadif'].includes(value) &&
                !['--interlace', '--vpp-yadif'].includes(nvVideoOptions[index - 1])),
        '-f', 'mp4', '--log-level', 'warn', '-o', temporary]
        : ['-nostdin', '-loglevel', 'error', '-y', ...ffmpegInput,
        '-map', '0:v:0', '-map', '0:a:0?', ...(prepare ? [] : ['-vf', 'yadif']), '-c:v', 'libx264', '-preset', 'fast',
        '-pix_fmt', 'yuv420p', ...(row.options?.quality === 'compact' ? ['-crf', '26'] : []),
        '-c:a', 'aac', '-movflags', '+faststart', '-f', 'mp4', temporary];
    const child = spawn(profile?.command || nvencc || ffmpeg, args, { windowsHide: true });
    let preparation;
    if (prepare) {
        const decoder = spawn(ffmpeg, ['-nostdin', '-loglevel', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
            ...filters,
            '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '2', '-f', 'nut', '-'],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        const decoded = new Promise(resolve => {
            decoder.on('error', resolve);
            decoder.on('close', code => resolve(code === 0 ? null : new Error('映像の前処理に失敗しました')));
        });
        preparation = Promise.all([decoded, pipeline(decoder.stdout, child.stdin).catch(error => {
            decoder.kill();
            return error;
        })]);
    }
    child.stdout.resume();
    let details = '';
    child.stderr.on('data', chunk => { details = (details + chunk).slice(-800); });
    child.on('error', error => { details = error.message; });
    child.on('close', async code => {
        try {
            const preparationError = preparation && (await preparation).find(Boolean);
            if (code !== 0) throw new Error(encoder + ': ' + (details || '終了コード ' + code));
            if (preparationError) throw preparationError;
            if (!fileSize(temporary)) throw new Error(encoder + ': MP4を出力できませんでした');
            if (shareMediaFiles) chmodSync(temporary, 0o666);
            renameSync(temporary, output);
            if (cuts.length) row.commercialCuts = cuts;
            else if (fromOriginal) delete row.commercialCuts;
            try { if (!reencode && (!row.importedVideo || row.importedVideo.format === 'ts')) await prepareCaptions(row); }
            catch (error) { throw new Error('MP4は保存済みです。字幕の抽出に失敗したため元のTSを保持しました: ' + error.message); }
            if (!reencode && !filtered && row.status === 'completed' && row.options?.autoEncode && row.options.deleteOriginal && !row.options.autoCommercialCut && !row.options.autoLogoRemoval) removeFile(input);
        } catch (error) {
            row.encodeError = error.message;
            removeFile(temporary);
        } finally {
            encoding.delete(row.id);
            save();
        }
    });
}

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

function startBatchEdit(input) {
    const { entries, cutCommercials, removeLogo, encodeProfile = '' } = input;
    if (!Array.isArray(entries) || !entries.length || entries.length > 40 ||
        typeof cutCommercials !== 'boolean' || typeof removeLogo !== 'boolean' || (!cutCommercials && !removeLogo) ||
        typeof encodeProfile !== 'string' || (encodeProfile && !profiles.has(encodeProfile))) {
        fail(400, '動画と編集内容、プロファイルを確認してください（最大40件）');
    }
    if (batchEdit?.running || encoding.size || automaticEdits.size || extractingLogo() ||
        [...commercialJobs.values()].some(job => job.status === 'running')) fail(409, '他の編集やエンコードが実行中です');
    const ids = new Set();
    const queue = entries.map(entry => {
        const row = state.reservations.find(row => row.id === entry?.id);
        if (!row || ids.has(row.id) || !['completed', 'failed', 'cancelled'].includes(row.status) ||
            active.has(row.id) || !fileSize(commercialSource(row))) fail(400, '編集元の動画を確認してください');
        ids.add(row.id);
        const selectedLogo = removeLogo && entry.logo != null ? editLogo(entry.logo) : null;
        return { row, region: entry.logo, selectedLogo, item: { id: row.id, title: row.title, status: '待機中' } };
    });
    batchEdit = { running: true, items: queue.map(entry => entry.item) };
    for (const { row } of queue) automaticEdits.add(row.id);
    void (async () => {
        for (const { row, region, selectedLogo, item } of queue) {
            try {
                let logo = '', cuts = [], hasAudio = false;
                if (removeLogo) {
                    item.status = 'ロゴ範囲を確認中';
                    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
                        '-show_entries', 'stream=width,height', '-of', 'json', commercialSource(row)], { timeout: 15000 });
                    const video = JSON.parse(stdout).streams?.[0];
                    const key = [row.importedVideo ? row.id : row.service, row.importedVideo?.format ?? 'ts', video?.width, video?.height].join('/');
                    const area = region ?? preferredEditLogo(row, encodeProfile) ?? state.logoRegions?.[key];
                    if (!video || !area) throw new Error('元動画のロゴ範囲が指定されていません');
                    logo = selectedLogo ?? editLogo(area);
                    if (logo.lgd && (logo.x < 0 || logo.y < 0 || logo.x + logo.width > video.width || logo.y + logo.height > video.height)) {
                        throw new Error('LGDロゴの位置が元動画の映像サイズを超えています');
                    }
                    if (!logo.lgd && (area.x + area.w > video.width - 2 || area.y + area.h > video.height - 2)) {
                        throw new Error('ロゴ範囲が元動画の映像サイズを超えています');
                    }
                }
                if (cutCommercials) {
                    item.status = 'CM解析中';
                    const { job, finished } = startCommercialDetection(row);
                    await finished;
                    if (job.status !== 'ready') throw new Error(job.error);
                    ({ cuts, hasAudio } = job);
                }
                if (!cuts.length && !logo) {
                    item.status = 'CM候補なし';
                    continue;
                }
                item.status = '変換中';
                await encode(row, cuts, hasAudio, logo, { encodeProfile: encodeProfile || undefined, fromOriginal: true });
                while (encoding.has(row.id)) await delay(500);
                if (row.encodeError) throw new Error(row.encodeError);
                item.status = '完了';
            } catch (error) {
                item.status = '失敗';
                item.error = error.message;
            } finally { automaticEdits.delete(row.id); }
        }
        batchEdit.running = false;
    })();
    return batchEdit;
}
function recordingOptions(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, '録画設定が不正です');
    const { destination = 'default', encodeDestination = '', subDirectory = '', fileName = 'default', recordedFormat = '', quality = 'standard', encodeProfile = '',
        autoEncode = false, deleteOriginal = false, autoCommercialCut = false, autoLogoRemoval = false } = input;
    if (!destinations.has(destination) || (encodeDestination !== '' && !destinations.has(encodeDestination))) fail(400, '保存先を選択してください');
    if (typeof subDirectory !== 'string' || subDirectory.length > 240) fail(400, 'サブフォルダを確認してください');
    const relativeDirectory = subDirectory.trim().replace(/\\/g, '/');
    if (relativeDirectory && relativeDirectory.split('/').some(part =>
        !part || /[<>:"|?*\x00-\x1f]|[. ]$|^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(part) ||
        Buffer.byteLength(part) > 255)) fail(400, 'サブフォルダには「ドラマ/2026」のように保存先からの相対パスを指定してください');
    if (!['default', 'id', 'title'].includes(fileName) || !validRecordedFormat(recordedFormat) || !['standard', 'compact'].includes(quality) ||
        [autoEncode, deleteOriginal, autoCommercialCut, autoLogoRemoval].some(value => typeof value !== 'boolean')) fail(400, '録画設定を確認してください');
    if (encodeProfile !== '' && !profiles.has(encodeProfile)) fail(400, 'エンコードプロファイルを選択してください');
    return { destination, encodeDestination, subDirectory: relativeDirectory, fileName, recordedFormat, quality, encodeProfile, autoEncode, autoCommercialCut: autoEncode && autoCommercialCut, autoLogoRemoval: autoEncode && autoLogoRemoval,
        deleteOriginal: autoEncode && deleteOriginal };
}
function ruleConditions(input) {
    const word = (key, max) => {
        const value = input[key] ?? '';
        if (typeof value !== 'string' || value.trim().length > max) fail(400, 'キーワードは' + max + '文字以内で入力してください');
        return value.trim();
    };
    const keyword = word('keyword', 512), exclude = word('exclude', 120);
    const { keywordMatch = 'text' } = input;
    const { splitKeywords = false, skipDuplicateEpisodes = false, dateFrom = '', dateTo = '' } = input;
    if (typeof splitKeywords !== 'boolean') fail(400, 'キーワードの分割設定が不正です');
    if (typeof skipDuplicateEpisodes !== 'boolean') fail(400, '放送回の重複設定が不正です');
    const validDate = value => typeof value === 'string' && (value === '' ||
        (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
            new Date(value).toISOString().slice(0, 10) === value));
    if (!validDate(dateFrom) || !validDate(dateTo) || (dateFrom && dateTo && dateFrom > dateTo)) {
        fail(400, '放送日の範囲を確認してください');
    }
    if (!['text', 'title', 'titleExact'].includes(keywordMatch)) fail(400, 'キーワードの照合方法を選択してください');
    if (keywordMatch !== 'text' && !keyword) fail(400, '番組名を入力してください');
    const { wave = '', genre = null, days = [], from = '', to = '' } = input;
    const stations = ruleServices(input);
    if (!Array.isArray(stations) || stations.length > serviceMap.size ||
        stations.some(id => !serviceMap.has(id) || isHidden(id))) fail(400, '表示対象の放送局を選択してください');
    const selected = [...new Set(stations)];
    if (wave !== '' && (!services.some(s => !isHidden(s.id) && s.channel?.type === wave) ||
        selected.some(id => serviceMap.get(id).channel?.type !== wave))) {
        fail(400, '放送波と放送局の組み合わせを確認してください');
    }
    if (genre !== null && (!Number.isInteger(genre) || genre < 0 || genre > 15)) fail(400, 'ジャンルが不正です');
    const { subgenre = null } = input;
    if (subgenre !== null && (genre === null || !Number.isInteger(subgenre) || subgenre < 0 || subgenre > 15)) {
        fail(400, 'ジャンルとサブジャンルを確認してください');
    }
    if (!Array.isArray(days) || days.some(d => !['日', '月', '火', '水', '木', '金', '土'].includes(d))) fail(400, '曜日が不正です');
    const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (typeof from !== 'string' || typeof to !== 'string' ||
        ((from || to) && (!clock.test(from) || !clock.test(to) || from === to))) {
        fail(400, '開始・終了に異なる時刻を指定してください');
    }
    if (!keyword && !exclude && !selected.length && !wave && genre === null && !days.length && !from && !dateFrom && !dateTo) {
        fail(400, '少なくとも1つの条件を入力してください');
    }
    return { keyword, keywordMatch, splitKeywords, skipDuplicateEpisodes, exclude, service: selected[0] ?? null, services: selected,
        wave, genre, subgenre, days: [...new Set(days)], from, to, dateFrom, dateTo,
        options: recordingOptions(input.options) };
}

async function browserLive(res, service, recording, offset = 0, captionId = null, profile = null, hls = null) {
    const used = [...state.reservations.filter(r => active.has(r.id)).map(r => r.service),
        ...[...liveSessions.values()].map(session => session.service)];
    if (!recording && !fitsTuners([...used, service], serviceMap, tuners)) fail(409, '録画・視聴により空きチューナーがありません');
    if (liveSessions.size >= liveLimit) fail(503, '同時視聴の上限に達しました');
    const controller = new AbortController();
    let child, decoder, muxer;
    const stop = () => {
        controller.abort();
        child?.kill();
        decoder?.kill();
        muxer?.kill();
    };
    const session = { service, stop, recordingId: recording?.id, captionId, captions: [], captionSequence: 0 };
    const key = hls || res;
    liveSessions.set(key, session);
    if (hls) hls.stop = stop;
    else res.once('close', stop);
    const startup = hls ? null : setTimeout(stop, 30_000);
    try {
        const response = recording ? null : await fetch(source + '/api/services/' + service + '/stream', {
            signal: controller.signal, headers: { 'X-Mirakurun-Priority': '0' }
        });
        if (response && (!response.ok || !response.body)) fail(502, 'チューナー HTTP ' + response.status);
        const input = recording ? recordingPath(recording, hls?.format || 'ts') : null;
        const encoder = profile?.encoder ?? (nvencc && (!hls || !recording) ? 'nvencc' : 'ffmpeg');
        const command = profile?.command || (encoder === 'nvencc' ? nvencc : ffmpeg);
        const hardware = encoder !== 'ffmpeg';
        const mp4 = hardware || Boolean(profile);
        const prepare = hardware && Boolean(profile);
        // Normalize to square pixels before the hardware encoder receives raw frames.
        const videoFilter = "yadif,scale=-2:'min(" + (profile?.height ?? 720) + ",ih)'" +
            (prepare || hls ? ':reset_sar=1' : '');
        const segmentOptions = hls ? ['-f', 'hls', '-hls_time', '2', '-hls_list_size', recording ? '0' : '8',
            '-hls_flags', recording ? 'independent_segments+temp_file' : 'independent_segments+delete_segments+temp_file',
            ...(recording ? ['-hls_playlist_type', 'event'] : []),
            '-start_number', '0', '-hls_segment_filename', join(hls.folder, 'seg-%d.ts'),
            join(hls.folder, 'index.m3u8')] : [];
        // The hardware encoders can enable faststart for mp4 output, which requires a seekable file.
        // The ismv muxer can write fragmented MP4 directly to stdout.
        const args = hardware ? [
            '--avsw', '--input-format', prepare ? 'nut' : 'mpegts', ...(offset ? ['--seek', String(offset)] : []), '-i', input || '-',
            ...(prepare ? [
                '--codec', 'h264', '--vbr', String(profile.bitrate), '--bframes', '0', '--gop-len', '30',
                '--audio-codec', 'aac', '--audio-bitrate', '128'] : nvVideoOptions), '-f', 'ismv',
            '--mux-option', 'movflags:frag_keyframe+empty_moov+default_base_moof',
            '--mux-option', 'flush_packets:1', '--log-level', 'warn', '-o', '-'
        ] : ['-nostdin', '-loglevel', 'error', ...(hls && recording ? ['-readrate', '1.5'] : []),
            ...(offset ? ['-ss', String(offset)] : []), '-i', input || 'pipe:0',
            '-map', '0:v:0', '-map', '0:a:0?', '-vf', videoFilter,
            ...(profile || hls ? ['-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
                '-b:v', (profile?.bitrate ?? 2200) + 'k', '-g', '30', '-c:a', 'aac', '-ac', '2', '-b:a', '128k',
                ...(hls ? ['-force_key_frames', 'expr:gte(t,n_forced*2)', ...segmentOptions] :
                    ['-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-flush_packets', '1', '-f', 'mp4', 'pipe:1'])] : [
            '-pix_fmt', 'yuv420p', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '6',
            '-threads', '4', '-b:v', '2200k', '-g', '60', '-c:a', 'libopus',
            '-flush_packets', '1', '-live', '1', '-cluster_time_limit', '500', '-f', 'webm', 'pipe:1'])];
        child = spawn(command, args, { windowsHide: true });
        let diagnostic = '';
        child.on('error', error => { diagnostic = error.message; });
        child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
        if (prepare) {
            decoder = spawn(ffmpeg, ['-nostdin', '-loglevel', 'error', '-i', 'pipe:0', '-map', '0:v:0',
                '-map', '0:a:0?', '-vf', videoFilter, '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p',
                '-c:a', 'pcm_s16le', '-ac', '2', '-f', 'nut', 'pipe:1'], { windowsHide: true });
            decoder.on('error', error => { diagnostic = error.message; });
            decoder.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
            void pipeline(decoder.stdout, child.stdin).catch(() => decoder.kill());
        }
        if (response) {
            let inputStream = response.body;
            if (captionId) {
                const captions = new PassThrough({ highWaterMark: 1024 * 1024 });
                captions.on('error', () => {});
                controller.signal.addEventListener('abort', () => captions.destroy(), { once: true });
                inputStream = inputStream.pipeThrough(new TransformStream({
                    transform(chunk, output) {
                        if (!captions.destroyed && !captions.write(chunk)) captions.destroy(new Error('字幕処理が配信に追いつきません'));
                        output.enqueue(chunk);
                    },
                    flush() { captions.end(); }
                }));
                void readLiveCaptions(Readable.toWeb(captions), cue => {
                    session.captions.push({ ...cue, id: ++session.captionSequence });
                    if (session.captions.length > 160) session.captions.shift();
                }).catch(error => {
                    session.captionError = true;
                    if (!controller.signal.aborted) console.error('ライブ字幕:', error.message);
                }).finally(() => captions.destroy());
            }
            void pipeline(Readable.fromWeb(inputStream), (decoder || child).stdin).catch(() => {});
        } else child.stdin.end();
        if (hls) {
            if (hardware) {
                muxer = spawn(ffmpeg, ['-nostdin', '-loglevel', 'error', '-i', 'pipe:0', '-map', '0:v:0',
                    '-map', '0:a:0?', '-c', 'copy', ...segmentOptions], { windowsHide: true });
                muxer.on('error', error => { diagnostic = error.message; });
                muxer.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
            }
            const output = muxer || child;
            const completion = new Promise(resolve => output.once('close', resolve));
            output.stdout.resume();
            if (muxer) void pipeline(child.stdout, muxer.stdin).catch(() => muxer.kill());
            const code = await completion;
            if (code !== 0 && !controller.signal.aborted) {
                console.error('HLS:', diagnostic || code);
                fail(502, 'HLSの配信を開始できませんでした');
            }
            return;
        }
        const stream = child.stdout[Symbol.asyncIterator]();
        const first = await stream.next();
        if (first.done) {
            const name = encoderNames[encoder];
            console.error('ライブ配信:', diagnostic || name + ' output closed');
            fail(502, recording ? '録画の配信を開始できません。' + name + 'と録画ファイルを確認してください' :
                'ライブ映像を開始できません。' + name + 'とチューナーを確認してください');
        }
        clearTimeout(startup);
        res.writeHead(200, { 'Content-Type': mp4 ? 'video/mp4' : 'video/webm',
            'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        async function* output() {
            yield first.value;
            yield* { [Symbol.asyncIterator]: () => stream };
        }
        await pipeline(output(), res);
    } catch (error) {
        if (hls || !res.destroyed) {
            if (controller.signal.aborted) fail(503, 'ライブ視聴が停止しました');
            throw error;
        }
    } finally {
        clearTimeout(startup);
        liveSessions.delete(key);
        stop();
    }
}
function closeHls(id, session) {
    hlsSessions.delete(id);
    session.stop?.();
    void session.job.finally(() => {
        try { rmSync(session.folder, { recursive: true, force: true, maxRetries: 3 }); }
        catch (error) { console.error('HLS一時ファイル:', error.message); }
    });
}
setInterval(() => {
    for (const [id, session] of hlsSessions) {
        if (Date.now() - session.lastRequest > 60_000) closeHls(id, session);
    }
}, 10_000).unref();

async function serveHls(req, res, id, asset, params) {
    let session = hlsSessions.get(id);
    if (req.method === 'DELETE') {
        if (session) closeHls(id, session);
        return res.writeHead(204).end();
    }
    if (!session) {
        if (asset !== 'index.m3u8') fail(404, '配信が終了しました');
        const service = Number(params.get('service'));
        const recordingId = params.get('recording');
        const recording = recordingId && state.reservations.find(row => row.id === recordingId);
        const format = params.get('format') ?? 'ts';
        const offset = Number(params.get('start') ?? 0);
        if (recordingId) {
            if (!recording || !['ts', 'mp4'].includes(format) || !fileSize(recordingPath(recording, format))) fail(404, '録画ファイルがありません');
            if (active.has(recordingId)) fail(409, '録画中です');
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > 604800) fail(400, '再生位置が不正です');
        } else if (!source || !serviceMap.has(service) || isHidden(service)) fail(404, '放送局が見つかりません');
        const name = recording ? '' : params.get('profile') ?? defaultLiveProfile;
        if (name && !liveProfiles.has(name)) fail(400, 'ライブ用プロファイルを選択してください');
        if (hlsSessions.size >= liveLimit * 2 || liveSessions.size >= liveLimit) fail(503, '同時視聴の上限に達しました');
        session = { folder: mkdtempSync(join(tmpdir(), 'uzume-tv-hls-')), format, lastRequest: Date.now() };
        hlsSessions.set(id, session);
        session.job = browserLive(null, recording ? null : service, recording, offset, recording ? null : id,
            liveProfiles.get(name), session).catch(error => { session.error = error; }).finally(() => { session.finished = true; });
    }
    session.lastRequest = Date.now();
    const file = join(session.folder, asset);
    if (asset === 'index.m3u8') {
        const deadline = Date.now() + 35_000;
        let playlist;
        while (!res.destroyed && hlsSessions.get(id) === session) {
            if (fileSize(file)) {
                playlist = readFileSync(file);
                if (session.finished || /#EXTINF:[\s\S]+#EXTINF:/.test(playlist.toString())) break;
            }
            if (session.error || session.finished || Date.now() >= deadline) {
                closeHls(id, session);
                throw session.error || Object.assign(new Error('再生できる映像を取得できませんでした'), { status: 502 });
            }
            await delay(150);
        }
        if (res.destroyed) return;
        if (hlsSessions.get(id) !== session) fail(404, '配信が終了しました');
        const headers = { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
        if (/(?:^|,\s*)gzip(?:\s*,|$)/i.test(req.headers['accept-encoding'] || '')) {
            playlist = gzipSync(playlist);
            headers['Content-Encoding'] = 'gzip';
        }
        return res.writeHead(200, headers).end(playlist);
    }
    const size = fileSize(file);
    if (!size) fail(404, '配信区間が見つかりません');
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': size, 'Cache-Control': 'private, max-age=60' });
    return await pipeline(createReadStream(file), res);
}
function json(res, value, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
}
async function readBody(req, allowEmpty = false) {
    if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'JSON が必要です');
    let data = '';
    for await (const chunk of req) {
        data += chunk;
        if (data.length > 16_384) fail(413, '入力が長すぎます');
    }
    if (allowEmpty && !data) return {};
    try {
        const value = JSON.parse(data);
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* Invalid JSON */ }
    fail(400, '入力形式が不正です');
}
async function prepareCaptions(row) {
    const sourceFile = recordingPath(row);
    const target = captionPath(row);
    if (!fileSize(target)) {
        if (active.has(row.id) || !fileSize(sourceFile)) fail(404, '字幕付きの録画TSがありません');
        if (!captionJobs.has(row.id)) {
            if (captionJobs.size >= 2) fail(503, '字幕を準備中です。少し待ってからお試しください');
            mkdirSync(join(directory, 'captions'), { recursive: true });
            const cli = join(root, 'subtitle-tools', 'node_modules', 'aribb24.js', 'dist', 'cjs', 'runtime', 'cli', 'bin', 'ts2ass.js');
            const ass = target + '.ass';
            const temporary = target + '.tmp';
            const job = (async () => {
                try {
                    await exec(process.execPath, [cli, '--input', sourceFile, '--output', ass, '--font', 'sans-serif', '--ruby', 'ignore'],
                        { timeout: 180000, windowsHide: true });
                    await exec(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', ass, '-f', 'webvtt', temporary],
                        { timeout: 15000, windowsHide: true });
                    renameSync(temporary, target);
                } finally {
                    removeFile(ass);
                    removeFile(temporary);
                    captionJobs.delete(row.id);
                }
            })();
            captionJobs.set(row.id, job);
        }
        try { await captionJobs.get(row.id); }
        catch (error) {
            console.error('録画字幕:', error.message);
            fail(502, '録画字幕を準備できませんでした');
        }
    }
    return target;
}
async function recordingCaptions(res, row, offset) {
    let vtt = readFileSync(await prepareCaptions(row), 'utf8');
    if (row.commercialCuts?.length && fileSize(recordingPath(row, 'mp4'))) vtt = cutCaptions(vtt, row.commercialCuts);
    if (offset) {
        const milliseconds = stamp => stamp.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) * 1000;
        const timestamp = ms => new Date(Math.round(ms)).toISOString().slice(11, 23);
        vtt = vtt.split(/\r?\n\r?\n/).map(block => {
            const times = /^(\d[\d:.]*) --> (\d[\d:.]*)/m.exec(block);
            if (!times) return block;
            const end = milliseconds(times[2]) - offset * 1000;
            if (end <= 0) return '';
            return block.replace(times[0], timestamp(Math.max(0, milliseconds(times[1]) - offset * 1000)) + ' --> ' + timestamp(end));
        }).filter(Boolean).join('\n\n') + '\n';
    }
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, no-cache' });
    res.end(vtt);
}
async function thumbnail(res, row) {
    const target = thumbnailPath(row);
    const mp4 = recordingPath(row, 'mp4');
    const ts = recordingPath(row);
    if (active.has(row.id) || (!fileSize(mp4) && !fileSize(ts))) fail(404, '録画ファイルがありません');
    if (!fileSize(target)) {
        if (!thumbnails.has(row.id)) {
            if (thumbnails.size >= 32) fail(503, 'サムネイルの生成待ちが上限に達しました');
            const job = thumbnailQueue.then(async () => {
                const input = fileSize(mp4) ? mp4 : ts;
                mkdirSync(join(directory, 'thumbnails'), { recursive: true });
                const temporary = target + '.part';
                const duration = (row.end - row.start) / 1000;
                const at = Number.isFinite(duration) ? Math.min(30, Math.max(0, duration / 4)) : 0;
                try {
                    for (const seek of new Set([at, 0])) {
                        removeFile(temporary);
                        const success = await new Promise(resolve => {
                            const child = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-ss', String(seek), '-i', input,
                                '-map', '0:v:0', '-frames:v', '1', '-vf',
                                'scale=320:180:force_original_aspect_ratio=decrease:reset_sar=1,pad=320:180:(ow-iw)/2:(oh-ih)/2',
                                '-an', '-c:v', 'mjpeg', '-f', 'image2', '-update', '1', temporary],
                            { windowsHide: true, stdio: 'ignore', timeout: 15000 });
                            child.on('error', () => resolve(false));
                            child.on('close', code => resolve(code === 0));
                        });
                        if (success && fileSize(temporary)) {
                            renameSync(temporary, target);
                            return;
                        }
                    }
                    fail(404, 'サムネイルを生成できませんでした');
                } finally { removeFile(temporary); }
            }).finally(() => thumbnails.delete(row.id));
            thumbnails.set(row.id, job);
            thumbnailQueue = job.catch(() => {});
        }
        try { await thumbnails.get(row.id); }
        catch {
            res.writeHead(404, { 'Cache-Control': 'private, max-age=300' }).end();
            return;
        }
    }
    const image = readFileSync(target);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    res.end(image);
}
async function media(req, res, row, format) {
    const path = recordingPath(row, format);
    const size = fileSize(path);
    if (!size) fail(404, '録画ファイルがありません');
    const headers = { 'Content-Type': format === 'mp4' ? 'video/mp4' : 'video/mp2t', 'Accept-Ranges': 'bytes' };
    if (format === 'ts') {
        const name = row.importedVideo ? basename(row.importedVideo.name) : (row.fileStem || row.id) + '.ts';
        headers['Content-Disposition'] = 'attachment; filename="' + row.id + extname(name).toLowerCase() +
            '"; filename*=UTF-8\x27\x27' + encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16));
    }
    let start = 0, end = size - 1;
    if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (match?.[1]) {
            start = Number(match[1]);
            if (match[2]) end = Math.min(end, Number(match[2]));
        } else if (match?.[2]) start = Math.max(0, size - Number(match[2]));
        else start = size;
        if (start > end) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + size }).end();
            return;
        }
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(req.headers.range ? 206 : 200, headers);
    if (req.method === 'HEAD') return res.end();
    await pipeline(createReadStream(path, { start, end }), res);
}

const assets = new Map([
    ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
    ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
    ['/sw.js', ['sw.js', 'text/javascript']],
    ['/icon-192.png', ['icon-192.png', 'image/png']],
    ['/wordmark.png', ['wordmark.png', 'image/png']],
    ['/icon-512.png', ['icon-512.png', 'image/png']],
    ['/scheduling.mjs', ['scheduling.mjs', 'text/javascript']]
]);
async function handleRequest(req, res) {
    try {
        const proxyUrl = proxyUrls.get(req.headers.host);
        const throughProxy = Boolean(proxyUrl);
        if (!throughProxy && !allowedHosts.has(req.headers.host)) fail(403, '接続先が不正です');
        const expectedOrigin = throughProxy ? proxyUrl.origin : 'http://' + req.headers.host;
        if (req.headers.origin && req.headers.origin !== expectedOrigin) fail(403, '外部サイトからの操作は許可されていません');
        const url = new URL(req.url, 'http://localhost');
        const method = req.method;
        const path = url.pathname;
        const hls = /^\/api\/hls\/([0-9a-f-]{36})\/(index\.m3u8|seg-\d+\.ts)$/.exec(path);
        if (hls && (method === 'GET' || (method === 'DELETE' && hls[2] === 'index.m3u8'))) {
            return await serveHls(req, res, hls[1], hls[2], url.searchParams);
        }
        if (method === 'GET' && assets.has(path)) {
            const [file, type] = assets.get(path);
            res.writeHead(200, { 'Content-Type': type.startsWith('image/') ? type : type + '; charset=utf-8' });
            return res.end(readFileSync(join(root, file)));
        }
        if (method === 'POST' && path === '/api/settings/apply') {
            await readBody(req);
            if (!canApplySettings) fail(409, 'この起動方法では手動で再起動してください');
            if (applyingSettings || active.size || encoding.size || automaticEdits.size || thumbnails.size || extractingLogo() ||
                state.reservations.some(r => r.status === 'scheduled' && !isHidden(r.service) &&
                    r.end > Date.now() && r.start - recordingStartMarginSeconds * 1000 <= Date.now() + 20_000)) {
                fail(409, '処理中、または間もなく録画を開始します。終了後に反映してください');
            }
            const next = loadConfig(root);
            applyingSettings = true;
            res.once('finish', () => setTimeout(() => process.exit(75), 200));
            return json(res, { port: next.port, instance: settingsInstance }, 202);
        }
        if (applyingSettings) fail(503, '設定を反映しています');
        if (path === '/api/settings' && ['GET', 'PUT'].includes(method)) {
            const current = loadConfig(root);
            const keys = ['port', 'tunerUrl', 'dataDirectory', 'ffmpeg', 'nvencc', 'qsvenc', 'vceenc', 'encodeProfiles', 'defaultEncodeProfile', 'liveProfiles', 'defaultLiveProfile', 'recordingDirectories', 'guideHiddenChannels', 'epgInterval', 'liveLimit', 'recordingStartMarginSeconds', 'recordingMinFreeGB', 'recordedFormat'];
            if (method === 'PUT') {
                const input = await readBody(req);
                const next = { ...current.config };
                for (const key of keys) if (Object.hasOwn(input, key)) next[key] = input[key];
                try { loadConfig(root, { DVR_CONFIG: process.env.DVR_CONFIG }, next); }
                catch (error) { fail(400, error.message); }
                const temporary = configFile + '.' + randomUUID() + '.tmp';
                try {
                    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
                    renameSync(temporary, configFile);
                } finally { removeFile(temporary); }
                return json(res, { restartRequired: true });
            }
            const config = Object.fromEntries(keys.filter(key => Object.hasOwn(current.config, key)).map(key => [key, current.config[key]]));
            return json(res, { config, canApplySettings, instance: settingsInstance, stations: services.map(({ id, name }) => ({ id, name })) });
        }
        if (method === 'GET' && ['/api/pvr/channels.m3u', '/api/pvr/guide.xml'].includes(path)) {
            const stations = services.filter(s => !isHidden(s.id));
            const base = throughProxy ? proxyUrl.href.slice(0, -1) : expectedOrigin;
            if (path.endsWith('.m3u')) {
                const label = value => String(value ?? '').replace(/["\r\n]/g, ' ').trim();
                const entries = stations.map(s => {
                    const wave = s.channel?.type === 'GR' ? '地上波' : s.channel?.type || 'その他';
                    return '#EXTINF:-1 tvg-id="' + s.id + '" group-title="' + label(wave) +
                        '" tvg-logo="' + base + '/api/logos/' + s.id + '",' + label(s.name) +
                        '\n' + base + '/api/live/' + s.id;
                });
                res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Cache-Control': 'no-cache' });
                return res.end(['#EXTM3U', ...entries].join('\n') + '\n');
            }
            const xml = value => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '')
                .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
            const stamp = value => new Date(value).toISOString().slice(0, 19).replace(/[-T:]/g, '') + ' +0000';
            const ids = new Set(stations.map(s => s.id));
            const channels = stations.map(s => '<channel id="' + s.id + '"><display-name>' + xml(s.name) +
                '</display-name><icon src="' + base + '/api/logos/' + s.id + '"/></channel>');
            const entries = programs.filter(p => ids.has(p.service)).map(p => '<programme start="' +
                stamp(p.start) + '" stop="' + stamp(p.end) + '" channel="' + p.service + '"><title lang="ja">' +
                xml(p.title) + '</title><desc lang="ja">' + xml(p.description) + '</desc></programme>');
            res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache' });
            return res.end(['<?xml version="1.0" encoding="UTF-8"?>', '<tv>', ...channels, ...entries, '</tv>'].join('\n'));
        }
        if (method === 'GET' && path === '/api/activity') {
            return json(res, { recording: active.size, encoding: new Set([...encoding, ...automaticEdits]).size });
        }
        if (path === '/api/batch-edit') {
            if (method === 'GET') return json(res, batchEdit && { ...batchEdit, items: batchEdit.items.map(item => ({
                ...item, progress: item.status === 'CM解析中' ? commercialJobs.get(item.id)?.progress : null
            })) });
            if (method === 'POST') return json(res, startBatchEdit(await readBody(req)), 202);
        }
        if (path === '/api/import-videos' && method === 'GET') {
            const destination = url.searchParams.get('destination');
            const folder = url.searchParams.get('folder') ?? '';
            const location = storagePath(destination, folder);
            if (!location || !statSync(location, { throwIfNoEntry: false })?.isDirectory()) fail(404, '保存先のフォルダーが見つかりません');
            const entries = await readdir(location, { withFileTypes: true });
            const folders = entries.filter(item => item.isDirectory()).map(item => item.name);
            const files = entries.filter(item => item.isFile() && /\.(mp4|ts|m2ts)$/i.test(item.name)).map(item => item.name);
            const sort = (a, b) => a.localeCompare(b, 'ja', { numeric: true });
            return json(res, { folders: folders.sort(sort), files: files.sort(sort) });
        }
        if (path === '/api/import-videos' && method === 'POST') {
            return json(res, await registerVideo(await readBody(req)), 201);
        }
        if (method === 'GET' && path === '/api/logo-data') {
            const folder = process.env.DVR_JLS_LOGOS;
            if (!folder) return json(res, { configured: false, logos: [] });
            const entries = await readdir(folder, { withFileTypes: true }).catch(error => {
                if (error.code === 'ENOENT') return [];
                throw error;
            });
            const logos = [];
            for (const entry of entries) {
                const match = /^(\d+)\.(lgd2?)$/.exec(entry.name);
                if (!entry.isFile() || !match || !Number.isSafeInteger(Number(match[1]))) continue;
                const service = Number(match[1]);
                if (String(service) !== match[1]) continue;
                logos.push({ service, name: serviceMap.get(service)?.name || '放送局 ' + service, format: match[2],
                    amatsukaze: supportsAmatsukazeLogo(entry.name) });
            }
            logos.sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.format.localeCompare(b.format));
            return json(res, { configured: true, logos });
        }
        const logoData = /^\/api\/logo-data\/(\d+)\.(lgd2?)$/.exec(path);
        if (method === 'GET' && logoData) {
            const folder = process.env.DVR_JLS_LOGOS;
            if (!folder) fail(404, 'ロゴデータがありません');
            const file = join(folder, logoData[1] + '.' + logoData[2]);
            const size = fileSize(file);
            if (!size) fail(404, 'ロゴデータがありません');
            if (size > 16 * 1024 * 1024) fail(422, 'ロゴデータが大きすぎます');
            let preview;
            try { preview = logoPreview(readFileSync(file)); }
            catch (error) { fail(422, error.message); }
            return json(res, preview);
        }
        if (method === 'GET' && path === '/api/guide') {
            const from = Number(url.searchParams.get('from') || Date.now() - 3_600_000);
            const to = Number(url.searchParams.get('to') || from + 86_400_000);
            return json(res, { services, guideHiddenChannels: [...guideHiddenChannels], demo: !source, syncedAt, syncError,
                liveProfiles: liveProfileOptions, defaultLiveProfile,
                programs: programs.filter(p => !isHidden(p.service) && p.end > from && p.start < to) });
        }
        if (method === 'POST' && path === '/api/sync') {
            await refresh();
            if (syncError) fail(502, syncError);
            return json(res, { syncedAt });
        }
        if (method === 'GET' && path === '/api/storage') {
            const storage = await Promise.all([...destinations].map(async ([name, location]) => {
                try {
                    const { bsize, blocks, bfree, bavail } = await statfs(location);
                    if (blocks <= 0 || bsize <= 0) return { name, unavailable: true };
                    return { name, total: blocks * bsize, used: (blocks - bfree) * bsize, available: bavail * bsize };
                } catch {
                    return { name, unavailable: true };
                }
            }));
            return json(res, { storage });
        }
        if (method === 'GET' && path === '/api/state') {
            const logoFormats = new Map();
            for (const key of Object.keys(state.logoRegions ?? {})) {
                const [service, format] = key.split('/');
                if (!logoFormats.has(service)) logoFormats.set(service, new Set());
                logoFormats.get(service).add(format);
            }
            const reservations = state.reservations.filter(row => row.status !== 'scheduled' || !isHidden(row.service));
            const rules = state.rules.filter(rule => {
                const stations = ruleServices(rule);
                return !stations.length || stations.some(id => !isHidden(id));
            });
            const conflicts = tuners === null ? new Set() : predictConflicts(reservations, serviceMap, tuners, Date.now(), recordingStartMarginSeconds);
            return json(res, { tunerCount: tuners?.length ?? null, destinations: [...destinations.keys()],
                canExtractLogo: Boolean(process.env.DVR_JLS_LOGO_GENERATOR && process.env.DVR_JLS_LOGOS),
                canAmatsukazeDelogo: Boolean(process.env.DVR_JLS_AMATSUKAZE),
                defaultEncodeProfile,
                encodeProfiles: [...profiles].map(([name, profile]) => ({ name, encoder: encoderNames[profile.encoder] })),
                liveProfiles: liveProfileOptions, defaultLiveProfile,
                rules, reservations: reservations.map(row => ({
                conflict: conflicts.has(row.id),
                savedLogoFormats: [...(logoFormats.get(row.importedVideo ? row.id : String(row.service)) ?? [])],
                ...(row.importedVideo ? { hasOriginalVideo: Boolean(fileSize(commercialSource(row))),
                    hasEditedVideo: Boolean(fileSize(editedVideoPath(row))) } : {}),
                automaticEditing: automaticEdits.has(row.id),
                ...row, ts: ['completed', 'failed', 'cancelled'].includes(row.status) && fileSize(recordingPath(row)) > 0,
                mp4: fileSize(recordingPath(row, 'mp4')) > 0, captions: fileSize(captionPath(row)) > 0, encoding: encoding.has(row.id) || automaticEdits.has(row.id)
            })) });
        }
        if (method === 'POST' && path === '/api/reservations') {
            const input = await readBody(req);
            const p = programs.find(p => p.id === input.programId && !isHidden(p.service) && p.end > Date.now());
            if (!p) fail(404, '予約できる番組が見つかりません');
            if (state.reservations.some(r => r.programId === p.id && ['scheduled', 'recording', 'completed'].includes(r.status))) {
                fail(409, 'この番組は予約済みまたは録画済みです');
            }
            const row = addReservation(p, null, null, recordingOptions(input.options));
            save();
            reconcile();
            void tick();
            return json(res, row, 201);
        }
        if (method === 'POST' && path === '/api/rules') {
            const input = await readBody(req);
            const rule = { id: randomUUID(), ...ruleConditions(input), enabled: true };
            state.rules.push(rule);
            save();
            reconcile();
            return json(res, rule, 201);
        }
        const match = /^\/api\/(reservations|rules)\/([a-f0-9-]{36})(?:\/(ts|mp4|encode|cancel|stream|thumbnail|logo-preview|logo-region|logo-extract|captions|commercials))?$/.exec(path);
        if (match) {
            const [, collection, id, action] = match;
            const rows = state[collection];
            const row = rows.find(item => item.id === id);
            if (!row) fail(404, '項目が見つかりません');
            if (collection === 'reservations') {
                if (row.importedVideo && !['GET', 'HEAD', 'DELETE'].includes(method) &&
                    !(method === 'POST' && ['commercials', 'encode', 'logo-extract'].includes(action)) &&
                    !(method === 'PUT' && ['logo-region', 'logo-extract'].includes(action))) fail(409, '登録動画にはこの操作を実行できません');
                if (action === 'logo-extract') {
                    if (method === 'POST') {
                        const input = await readBody(req);
                        if (!rows.includes(row)) fail(404, '録画が見つかりません');
                        const job = startLogoExtraction(row, input);
                        return json(res, { status: job.status, phase: job.phase }, 202);
                    }
                    if (method === 'PUT') {
                        const input = await readBody(req);
                        if (!rows.includes(row)) fail(404, '録画が見つかりません');
                        registerExtractedLogo(row, input);
                        return json(res, { status: 'registered' });
                    }
                    if (method === 'GET') {
                        const { status = 'idle', token, phase, progress, error, preview } = logoExtractions.get(id) ?? {};
                        return json(res, { status, token, phase, progress, error, preview });
                    }
                }
                if (method === 'PATCH' && !action) {
                    const input = await readBody(req);
                    if (row.status !== 'scheduled' || active.has(id) || row.start - recordingStartMarginSeconds * 1000 <= Date.now() || isHidden(row.service) ||
                        !state.reservations.includes(row)) fail(409, '録画開始前の予約を編集できます');
                    if (!input.options) fail(400, '録画設定を指定してください');
                    const updated = { ...row };
                    applyRecordingOptions(updated, recordingOptions(input.options));
                    delete row.fileStem;
                    Object.assign(row, updated);
                    save();
                    return json(res, row);
                }
                if (action === 'commercials' && method === 'GET') {
                    return json(res, commercialJobs.get(id) || { status: 'idle', cuts: [] });
                }
                if (action === 'commercials' && method === 'POST') {
                    const input = await readBody(req);
                    if (!state.reservations.includes(row) || active.has(id) || encoding.has(id) || automaticEdits.has(id) || !fileSize(commercialSource(row))) {
                        fail(409, 'CM検出には元の動画が必要です。変換中の場合は完了後にお試しください');
                    }
                    if (input.apply !== undefined) {
                        const job = commercialJobs.get(id);
                        if (job?.status !== 'ready' || !Array.isArray(input.apply) ||
                            !input.apply.every(i => Number.isInteger(i) && job.cuts[i])) fail(400, 'CM候補を選択してください');
                        const manual = input.manual ?? [];
                        if (!Array.isArray(manual) || manual.length > 100 || !manual.every(cut =>
                            Number.isFinite(cut?.start) && Number.isFinite(cut?.end) &&
                            cut.start >= 0 && cut.start < cut.end && cut.end <= job.duration)) {
                            fail(400, '手動区間は録画の長さ以内で、開始より終了を後にしてください');
                        }
                        const cuts = [...new Set(input.apply)].map(i => job.cuts[i]).concat(manual)
                            .sort((a, b) => a.start - b.start);
                        if (!cuts.length) fail(400, 'カットする区間を指定してください');
                        if (cuts.some((cut, i) => i && cuts[i - 1].end > cut.start) ||
                            cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0) >= job.duration - 1) {
                            fail(400, '重複しない区間を指定し、動画を1秒以上残してください');
                        }
                        await encode(row, cuts, job.hasAudio, editLogo(input.logo), { encodeProfile: input.encodeProfile });
                        return json(res, { encoding: true }, 202);
                    }
                    if (extractingLogo() || [...commercialJobs.values()].some(job => job.status === 'running')) fail(409, 'CM検出またはロゴ抽出を実行中です');
                    const { job } = startCommercialDetection(row);
                    return json(res, job, 202);
                }
                if (method === 'GET' && action === 'thumbnail') return await thumbnail(res, row);
                if (action === 'logo-region' && ['GET', 'PUT'].includes(method)) {
                    const format = url.searchParams.get('format');
                    const width = Number(url.searchParams.get('width'));
                    const height = Number(url.searchParams.get('height'));
                    if (!['ts', 'mp4'].includes(format) || ![width, height].every(n => Number.isInteger(n) && n >= 6 && n <= 8192)) {
                        fail(400, '映像形式と解像度を確認してください');
                    }
                    const key = [row.importedVideo ? row.id : row.service, format, width, height].join('/');
                    if (method === 'GET') return json(res, { region: state.logoRegions?.[key] ?? null });
                    const { region } = await readBody(req);
                    if (!state.reservations.includes(row)) fail(404, '録画が見つかりません');
                    if (!logoFilter(region) || region.x + region.w > width - 2 || region.y + region.h > height - 2) {
                        fail(400, 'ロゴ範囲は画像の境界から2ピクセル以上空けてください');
                    }
                    const { x, y, w, h } = region;
                    state.logoRegions ??= {};
                    state.logoRegions[key] = { x, y, w, h };
                    save();
                    return json(res, { region: state.logoRegions[key] });
                }
                if (method === 'GET' && action === 'logo-preview') {
                    const start = Number(url.searchParams.get('start') ?? 0);
                    const format = url.searchParams.get('format') ?? 'ts';
                    if (!['ts', 'mp4'].includes(format) || !Number.isSafeInteger(start) || start < 0 || start > 604800) {
                        fail(400, 'プレビューの形式または時刻が不正です');
                    }
                    const input = row.importedVideo && url.searchParams.get('source') === 'original' ?
                        commercialSource(row) : recordingPath(row, format);
                    if (active.has(id) || !fileSize(input)) fail(404, 'プレビュー用の録画ファイルがありません');
                    const { stdout } = await exec(ffmpeg, ['-nostdin', '-v', 'error', '-ss', String(start), '-i', input,
                        '-map', '0:v:0', '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', '-'],
                    { encoding: 'buffer', timeout: 10000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
                        .catch(() => fail(422, '指定位置の画像を取得できませんでした'));
                    if (!stdout.length) fail(422, '指定位置に映像がありません');
                    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
                    return res.end(stdout);
                }
                if (method === 'GET' && action === 'captions') {
                    const offset = Number(url.searchParams.get('start') ?? 0);
                    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 604800) fail(400, '再生位置が不正です');
                    return await recordingCaptions(res, row, offset);
                }
                if (method === 'GET' && action === 'stream') {
                    if (active.has(id)) fail(409, '録画中です');
                    if (!fileSize(recordingPath(row))) fail(404, '録画ファイルがありません');
                    const offset = Number(url.searchParams.get('start') ?? 0);
                    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 604800) fail(400, '再生位置が不正です');
                    return await browserLive(res, null, row, offset);
                }
                if (['GET', 'HEAD'].includes(method) && ['ts', 'mp4'].includes(action)) {
                    if (active.has(id)) fail(409, '録画中です');
                    return await media(req, res, row, action);
                }
                if (['GET', 'POST'].includes(method) && action === 'encode') {
                    const mp4 = fileSize(recordingPath(row, 'mp4')) > 0;
                    if (method === 'POST') {
                        const input = await readBody(req, true);
                        if (automaticEdits.has(id)) fail(409, '自動編集を実行中です');
                        if (input.reencode === true) {
                            if (typeof input.encodeProfile !== 'string') fail(400, 'プロファイルを選択してください');
                            if (!state.reservations.includes(row) || encoding.has(id) ||
                                commercialJobs.get(id)?.status === 'running' ||
                                ['scheduled', 'recording'].includes(row.status) || active.has(id)) fail(409, '処理中です');
                            if (!fileSize(recordingPath(row, 'mp4')) && !fileSize(recordingPath(row))) fail(404, '録画ファイルがありません');
                            await encode(row, [], false, '', { reencode: true, encodeProfile: input.encodeProfile });
                        } else if (input.logo != null) {
                            if (!state.reservations.includes(row) || active.has(id) || encoding.has(id) ||
                                commercialJobs.get(id)?.status === 'running') fail(409, '処理中です');
                            if (!fileSize(recordingPath(row, 'mp4')) && !fileSize(recordingPath(row))) fail(404, '録画ファイルがありません');
                            await encode(row, [], false, editLogo(input.logo), { encodeProfile: input.encodeProfile });
                        } else if (!mp4 && !encoding.has(id)) {
                            if (fileSize(recordingPath(row, 'mp4')) || !state.reservations.includes(row)) fail(409, '変換の状態が変わりました');
                            if (active.has(id)) fail(409, '録画中です');
                            if (!fileSize(recordingPath(row))) fail(404, '録画ファイルがありません');
                            await encode(row, [], false, logoFilter(input.logo));
                        }
                    }
                    const pending = encoding.has(id);
                    return json(res, { mp4, encoding: pending, error: row.encodeError || '',
                        encoder: encoderNames[profiles.get(row.options?.encodeProfile || defaultEncodeProfile)?.encoder] || (nvencc ? 'NVEncC' : 'FFmpeg') }, method === 'POST' && pending ? 202 : 200);
                }
                if (method === 'POST' && action === 'cancel') {
                    if (!['scheduled', 'recording'].includes(row.status)) fail(409, '取消できる予約がありません');
                    const queue = [row];
                    for (const item of queue) {
                        if (['scheduled', 'recording'].includes(item.status)) {
                            item.status = 'cancelled';
                            active.get(item.id)?.abort('cancel');
                        }
                        queue.push(...rows.filter(child => child.relayOf === item.id));
                    }
                    save();
                    return json(res, row);
                }
            }
            if (!action && method === 'DELETE') {
                if (collection === 'reservations') {
                    if (['scheduled', 'recording'].includes(row.status) || active.has(id) || encoding.has(id) || automaticEdits.has(id) || thumbnails.has(id) || captionJobs.has(id) || logoExtractions.get(id)?.status === 'running' || commercialJobs.get(id)?.status === 'running' ||
                        [...liveSessions.values()].some(session => session.recordingId === id)) fail(409, '処理中です');
                    const original = url.searchParams.get('deleteOriginal');
                    const converted = url.searchParams.get('deleteConverted');
                    if (original !== null || converted !== null) {
                        if (![original, converted].every(value => value === '0' || value === '1')) {
                            fail(400, '削除するファイルを確認してください');
                        }
                        const source = original === '1' ?
                            (row.importedVideo ? importedSourcePath(row.importedVideo) : recordingPath(row)) : null;
                        if (original === '1' && row.importedVideo && !source) fail(404, '登録した元ファイルが見つかりません');
                        if (converted === '1') removeFile(row.importedVideo ? editedVideoPath(row) : recordingPath(row, 'mp4'));
                        if (source) removeFile(source);
                    } else if (row.importedVideo) {
                        if (url.searchParams.get('deleteFile') === '1') {
                            const sourceFile = importedSourcePath(row.importedVideo);
                            if (!sourceFile) fail(404, '登録した動画ファイルが見つかりません');
                            removeFile(sourceFile);
                        }
                    } else {
                        removeFile(recordingPath(row));
                        removeFile(recordingPath(row, 'mp4'));
                    }
                    if (url.searchParams.get('keepRemaining') === '1' &&
                        (row.importedVideo
                            ? fileSize(importedSourcePath(row.importedVideo)) || fileSize(editedVideoPath(row))
                            : fileSize(recordingPath(row)) || fileSize(recordingPath(row, 'mp4')))) {
                        save();
                        return json(res, { retained: true });
                    }
                    removeFile(thumbnailPath(row));
                    removeFile(captionPath(row));
                    commercialJobs.delete(id);
                    logoExtractions.delete(id);
                }
                rows.splice(rows.indexOf(row), 1);
                save();
                return json(res, {});
            }
            if (!action && method === 'PATCH' && collection === 'rules') {
                const input = await readBody(req);
                if ('enabled' in input) {
                    if (typeof input.enabled !== 'boolean') fail(400, '有効状態を指定してください');
                    row.enabled = input.enabled;
                } else Object.assign(row, ruleConditions(input));
                save();
                reconcile();
                return json(res, row);
            }
        }
        const logo = /^\/api\/logos\/(\d+)$/.exec(path);
        if (method === 'GET' && logo && source && serviceMap.has(Number(logo[1])) && !isHidden(Number(logo[1]))) {
            const service = serviceMap.get(Number(logo[1]));
            const upstream = service.hasLogoData === false ? null : await fetch(source + '/api/services/' + service.id + '/logo', {
                signal: AbortSignal.timeout(5000), redirect: 'error'
            }).catch(() => null);
            const type = upstream?.headers.get('content-type')?.split(';')[0];
            if (upstream?.ok && upstream.body && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) {
                res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
                return await pipeline(Readable.fromWeb(upstream.body), res);
            }
            await upstream?.body?.cancel();
            if (Number.isSafeInteger(service.networkId) && Number.isSafeInteger(service.serviceId)) {
                const file = join(root, 'logos', service.networkId + '-' + service.serviceId + '.png');
                const size = fileSize(file);
                if (size > pngSignature.length && size <= 1_048_576) {
                    const image = readFileSync(file);
                    if (image.subarray(0, pngSignature.length).equals(pngSignature)) {
                        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
                        return res.end(image);
                    }
                }
            }
            res.writeHead(404, { 'Cache-Control': 'private, max-age=60' }).end();
            return;
        }
        const liveCaption = /^\/api\/live-captions\/([0-9a-f-]{36})$/.exec(path);
        if (method === 'GET' && liveCaption) {
            const session = [...liveSessions.values()].find(item => item.captionId === liveCaption[1]);
            return json(res, { cues: session?.captions ?? [], error: Boolean(session?.captionError) });
        }
        const browserStream = /^\/api\/watch\/(\d+)$/.exec(path);
        if (method === 'GET' && browserStream && source && serviceMap.has(Number(browserStream[1])) && !isHidden(Number(browserStream[1]))) {
            const captionId = url.searchParams.get('captions');
            if (captionId && !/^[0-9a-f-]{36}$/.test(captionId)) fail(400, '字幕セッションが不正です');
            const name = url.searchParams.get('profile') ?? defaultLiveProfile;
            if (name && !liveProfiles.has(name)) fail(400, 'ライブ用プロファイルを選択してください');
            return await browserLive(res, Number(browserStream[1]), null, 0, captionId, liveProfiles.get(name));
        }
        const live = /^\/api\/live\/(\d+)$/.exec(path);
        if (method === 'GET' && live && source && serviceMap.has(Number(live[1])) && !isHidden(Number(live[1]))) {
            const controller = new AbortController();
            res.once('close', () => controller.abort());
            const response = await fetch(source + '/api/services/' + live[1] + '/stream', {
                signal: controller.signal, headers: { 'X-Mirakurun-Priority': '0' }
            });
            if (!response.ok || !response.body) fail(502, 'チューナー HTTP ' + response.status);
            res.writeHead(200, { 'Content-Type': 'video/mp2t' });
            return await pipeline(Readable.fromWeb(response.body), res);
        }
        fail(404, 'ページが見つかりません');
    } catch (error) {
        if (res.destroyed) return;
        if (res.headersSent) return res.destroy();
        if (!error.status) console.error(error);
        json(res, { error: error.status ? error.message : 'サーバー内でエラーが発生しました' }, error.status || 500);
    }
}
await refresh();
for (const address of lanAddress ? ['127.0.0.1', lanAddress] : ['127.0.0.1']) {
    http.createServer(handleRequest).listen(port, address, () =>
        console.log('http://' + address + ':' + port + (source ? '' : ' （デモ）')));
}
setInterval(() => void refresh(), epgInterval * 1000);
setInterval(tick, 1_000);
let checkingRecordingSpace = false;
setInterval(async () => {
    if (checkingRecordingSpace || !recordingMinFreeGB || applyingSettings) return;
    checkingRecordingSpace = true;
    try {
        const locations = new Set(state.reservations.filter(row => active.has(row.id))
            .map(row => row.tsDirectory || directory));
        for (const location of locations) await ensureRecordingSpace(location);
    } finally { checkingRecordingSpace = false; }
}, 30_000);
setInterval(async () => {
    if (applyingSettings || encoding.size || automaticEdits.size || extractingLogo() ||
        [...commercialJobs.values()].some(job => job.status === 'running')) return;
    const row = state.reservations.find(r => r.status === 'completed' && r.options?.autoEncode && !r.encodeError &&
        !fileSize(recordingPath(r, 'mp4')) && fileSize(recordingPath(r)) > 0);
    if (!row) return;
    automaticEdits.add(row.id);
    try {
        let cuts = [], hasAudio = false, logo = '';
        if (row.options.autoLogoRemoval) {
            const preferred = preferredEditLogo(row);
            if (preferred) logo = editLogo(preferred);
            else {
                const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
                    '-show_entries', 'stream=width,height', '-of', 'json', recordingPath(row)], { timeout: 15000 });
                const video = JSON.parse(stdout).streams[0];
                const region = video && state.logoRegions?.[[row.service, 'ts', video.width, video.height].join('/')];
                if (!region) throw new Error('自動ロゴ消しに使う、この局・解像度のTS用ロゴ範囲が保存されていません');
                logo = logoFilter(region);
            }
        }
        if (row.options.autoCommercialCut) {
            const { job, finished } = startCommercialDetection(row);
            await finished;
            if (job.status !== 'ready') throw new Error(job.error);
            ({ cuts, hasAudio } = job);
        }
        await encode(row, cuts, hasAudio, logo);
    } catch (error) {
        row.encodeError = error.message;
        save();
    } finally {
        automaticEdits.delete(row.id);
    }
}, 1_000);
