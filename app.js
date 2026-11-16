import { matchesRule, ruleServices } from './scheduling.mjs';

const content = document.querySelector('#content');
const appearanceKey = 'dvr-appearance';
let appearance = { theme: 'dark', accent: '#a6e6d3', subtitleColor: '#ffffff' };
try {
    const saved = JSON.parse(localStorage.getItem(appearanceKey));
    if (['light', 'dark'].includes(saved?.theme) && /^#[0-9a-f]{6}$/i.test(saved.accent)) {
        appearance.theme = saved.theme;
        appearance.accent = saved.accent;
    }
    if (/^#[0-9a-f]{6}$/i.test(saved?.subtitleColor)) appearance.subtitleColor = saved.subtitleColor;
} catch {}
function applyAppearance() {
    const root = document.documentElement;
    const { theme, accent } = appearance;
    const rgb = accent.slice(1).match(/../g).map(hex => parseInt(hex, 16) / 255)
        .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    root.dataset.theme = theme;
    root.style.setProperty('--subtitle-color', appearance.subtitleColor);
    root.style.setProperty('--accent-fill', accent);
    root.style.setProperty('--on-accent', luminance > 0.179 ? '#000' : '#fff');
    root.style.setProperty('--accent', theme === 'light'
        ? 'color-mix(in srgb, ' + accent + ' 48%, black)'
        : 'color-mix(in srgb, ' + accent + ' 48%, white)');
    if (theme === 'dark' && accent === '#a6e6d3') root.style.setProperty('--accent', accent);
}
applyAppearance();
const notice = document.querySelector('#notice');
const dialog = document.querySelector('#detail');
const details = document.querySelector('#details');
const titles = { tv: 'テレビをみる', guide: '番組表', search: '番組検索', reservations: '予約', recordings: '録画一覧', rules: '自動予約', storage: 'ストレージ', settings: '設定' };
const statuses = { scheduled: '予約済み', recording: '録画中', completed: '録画済み', failed: '録画失敗', cancelled: '取消済み', demo: 'デモ終了' };
const genres = ['ニュース・報道', 'スポーツ', '情報・ワイドショー', 'ドラマ', '音楽', 'バラエティ', '映画', 'アニメ・特撮', 'ドキュメンタリー・教養', '劇場・公演', '趣味・教育', '福祉'];
const mainGenre = program => genres[program.genres?.[0]] ? program.genres[0] : 15;
const genreName = id => genres[id] || 'その他・未分類';
const subgenres = [
    ['定時・総合', '天気', '特集・ドキュメント', '政治・国会', '経済・市況', '海外・国際', '解説', '討論・会談', '報道特番', 'ローカル・地域', '交通'],
    ['スポーツニュース', '野球', 'サッカー', 'ゴルフ', 'その他の球技', '相撲・格闘技', 'オリンピック・国際大会', 'マラソン・陸上・水泳', 'モータースポーツ', 'マリン・ウィンタースポーツ', '競馬・公営競技'],
    ['芸能・ワイドショー', 'ファッション', '暮らし・住まい', '健康・医療', 'ショッピング・通販', 'グルメ・料理', 'イベント', '番組紹介・お知らせ'],
    ['国内ドラマ', '海外ドラマ', '時代劇'],
    ['国内ロック・ポップス', '海外ロック・ポップス', 'クラシック・オペラ', 'ジャズ・フュージョン', '歌謡曲・演歌', 'ライブ・コンサート', 'ランキング・リクエスト', 'カラオケ・のど自慢', '民謡・邦楽', '童謡・キッズ', '民族音楽・ワールドミュージック'],
    ['クイズ', 'ゲーム', 'トークバラエティ', 'お笑い・コメディ', '音楽バラエティ', '旅バラエティ', '料理バラエティ'],
    ['洋画', '邦画', 'アニメ'],
    ['国内アニメ', '海外アニメ', '特撮'],
    ['社会・時事', '歴史・紀行', '自然・動物・環境', '宇宙・科学・医学', 'カルチャー・伝統文化', '文学・文芸', 'スポーツ', 'ドキュメンタリー全般', 'インタビュー・討論'],
    ['現代劇・新劇', 'ミュージカル', 'ダンス・バレエ', '落語・演芸', '歌舞伎・古典'],
    ['旅・釣り・アウトドア', '園芸・ペット・手芸', '音楽・美術・工芸', '囲碁・将棋', '麻雀・パチンコ', '車・オートバイ', 'コンピュータ・TVゲーム', '会話・語学', '幼児・小学生', '中学生・高校生', '大学生・受験', '生涯教育・資格', '教育問題'],
    ['高齢者', '障害者', '社会福祉', 'ボランティア', '手話', '文字（字幕）', '音声解説']
];
const subgenreName = (genre, id) => subgenres[genre]?.[id] ?? (id === 15 ? 'その他' : '分類 ' + id);
const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
const day = 86_400_000;
const hour = 3_600_000;
const pixelsPerHour = 120;
const jstOffset = 9 * hour;
const dayStart = value => Math.floor((value + jstOffset) / day) * day - jstOffset;
const timeFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' });
const time = value => timeFormat.format(value);
const date = value => dateFormat.format(value);
let from = dayStart(Date.now());
let guideScroll = { left: 0, top: 0 };
let guide, state, view, version = 0;
let visibleServices = [];
let keyword = '', channelType = '';
const guideWaveKey = 'dvr-guide-wave';
try { channelType = localStorage.getItem(guideWaveKey) || ''; } catch {}
let tv, tvWave = '';

function node(tag, label, className) {
    const element = document.createElement(tag);
    if (label !== undefined) element.textContent = label;
    if (className) element.className = className;
    return element;
}
function button(label, action, className) {
    const element = node('button', label, className);
    element.type = 'button';
    element.onclick = async () => {
        element.disabled = true;
        try { await action(); } catch (error) { message(error.message); }
        finally { element.disabled = false; }
    };
    return element;
}
function link(label, href) {
    const element = node('a', label);
    element.href = href;
    return element;
}
function message(value) {
    notice.textContent = value;
    notice.hidden = !value;
}
async function api(path, method = 'GET', data) {
    const response = await fetch('./api/' + path, {
        method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
}
async function mutate(path, method, data, text) {
    await api(path, method, data);
    message(text);
    await load();
}
function channel(id) {
    return guide.services.find(service => service.id === id)?.name || '放送局 ' + id;
}
function choose(options, label) {
    const select = node('select');
    select.setAttribute('aria-label', label);
    for (const [value, text] of options) {
        const option = node('option', text);
        option.value = value;
        select.append(option);
    }
    return select;
}
function bindSubgenre(genre, subgenre, selected) {
    function update(value = '') {
        const options = [['', 'すべて']];
        if (genre.value !== '') {
            const id = Number(genre.value);
            const codes = new Set((subgenres[id] || []).map((_, i) => i));
            for (const p of guide.programs) {
                for (const detail of p.genreDetails || []) if (detail.lv1 === id) codes.add(detail.lv2);
            }
            codes.add(15);
            if (value !== '') codes.add(Number(value));
            options.push(...[...codes].sort((a, b) => a - b).map(code => [code, subgenreName(id, code)]));
        }
        subgenre.replaceChildren(...choose(options, 'サブジャンル').children);
        subgenre.value = genre.value === '' ? '' : value;
        subgenre.disabled = genre.value === '';
    }
    update(String(selected ?? ''));
    genre.addEventListener('change', () => update());
}
function recordingSettings(options = {}) {
    const fields = node('fieldset', undefined, 'rule-days');
    fields.append(node('legend', '録画・保存設定'));
    const locations = (state.destinations || ['default']).map(name => [name, name === 'default' ? '既定の保存先' : name]);
    function select(label, choices, value) {
        const input = choose(choices, label);
        input.value = value;
        const wrapper = node('label', label);
        wrapper.append(input);
        fields.append(wrapper);
        return input;
    }
    const destination = select('TS保存先', locations, options.destination || 'default');
    const encodeDestination = select('MP4保存先', [['', 'TSと同じ'], ...locations], options.encodeDestination || '');
    const subDirectoryLabel = node('label', 'サブフォルダ（TS・MP4共通）');
    const subDirectory = node('input');
    subDirectory.maxLength = 240;
    subDirectory.placeholder = '例 ドラマ/2026';
    subDirectory.value = options.subDirectory || '';
    subDirectoryLabel.append(subDirectory);
    fields.append(subDirectoryLabel);
    const fileName = select('ファイル名', [['default', '既定または書式指定'], ['id', '録画ID'], ['title', '録画IDと番組名']], options.fileName || 'default');
    const formatLabel = node('label', 'ファイル名の書式');
    const format = node('input');
    format.maxLength = 240;
    format.placeholder = '%YEAR%-%MONTH%-%DAY%_%TITLE%';
    format.value = options.recordedFormat || '';
    formatLabel.append(format);
    fields.append(formatLabel);
    const quality = select('MP4画質', [['standard', '標準'], ['compact', '容量優先']], options.quality || 'standard');
    const profiles = (state.encodeProfiles || []).map(({ name, encoder }) => [name, name + '（' + encoder + '）']);
    if (options.encodeProfile && !profiles.some(([name]) => name === options.encodeProfile)) {
        profiles.push([options.encodeProfile, options.encodeProfile + '（設定なし）']);
    }
    const encodeProfile = select('エンコードプロファイル', [['', '既定のエンコード'], ...profiles], options.encodeProfile || '');
    function checkbox(label, checked) {
        const input = node('input');
        input.type = 'checkbox';
        input.checked = Boolean(checked);
        const wrapper = node('label');
        wrapper.append(input, label);
        fields.append(wrapper);
        return input;
    }
    const autoEncode = checkbox('録画後にMP4へ自動変換', options.autoEncode);
    const autoCommercialCut = checkbox('CM候補を自動検出してカット', options.autoCommercialCut);
    const autoLogoRemoval = checkbox('この局の保存済み範囲でロゴ消し', options.autoLogoRemoval);
    const deleteOriginal = checkbox('変換成功後に元のTSを削除', options.deleteOriginal);
    const update = () => {
        autoCommercialCut.disabled = autoLogoRemoval.disabled = !autoEncode.checked;
        deleteOriginal.disabled = !autoEncode.checked || autoCommercialCut.checked || autoLogoRemoval.checked;
        format.disabled = fileName.value !== 'default';
        quality.disabled = Boolean(encodeProfile.value);
    };
    autoEncode.onchange = update;
    autoCommercialCut.onchange = autoLogoRemoval.onchange = update;
    fileName.onchange = update;
    encodeProfile.onchange = update;
    update();
    return { fields, read: () => ({ destination: destination.value, encodeDestination: encodeDestination.value,
        subDirectory: subDirectory.value.trim(),
        fileName: fileName.value, recordedFormat: format.disabled ? '' : format.value.trim(),
        quality: quality.value, encodeProfile: encodeProfile.value, autoEncode: autoEncode.checked,
        autoCommercialCut: autoEncode.checked && autoCommercialCut.checked,
        autoLogoRemoval: autoEncode.checked && autoLogoRemoval.checked,
        deleteOriginal: !deleteOriginal.disabled && deleteOriginal.checked }) };
}
function programDetails(p) {
    const existing = state.reservations.find(row => row.programId === p.id && ['scheduled', 'recording', 'completed'].includes(row.status));
    details.replaceChildren(node('h2', p.title), node('p', date(p.start) + ' ' + time(p.start) + '–' + time(p.end) + '　' + channel(p.service), 'meta'), node('p', p.description || '番組説明はありません。'));
    if (existing) details.append(node('p', existing.conflict ? 'チューナー競合の見込み' : statuses[existing.status], 'status'));
    else if (p.end > Date.now()) {
        const settings = recordingSettings();
        const feedback = node('p', '', 'warning');
        feedback.setAttribute('role', 'status');
        details.append(settings.fields, button('録画予約', async () => {
            try {
                await mutate('reservations', 'POST', { programId: p.id, options: settings.read() }, '予約を登録しました。');
                dialog.close();
            } catch (error) { feedback.textContent = error.message; }
        }, 'primary'), feedback);
    }
    details.append(button('自動予約ルールを作成', () => {
        const form = ruleForm({ keyword: p.title, keywordMatch: 'title', service: p.service }, async data => {
            await mutate('rules', 'POST', data, '自動予約ルールを追加しました。');
            dialog.close();
        });
        details.replaceChildren(node('h2', '自動予約ルールを作成'), form,
            button('番組詳細に戻る', () => programDetails(p)));
        form.querySelector('input')?.focus();
    }));
    if (!dialog.open) dialog.showModal();
}
function stopVideo(video, switching = false) {
    video.dispatchEvent(new Event('dvr-stop'));
    if (!switching) {
        video.onplaying = null;
        video.onerror = null;
        video.onended = null;
    }
    video.removeAttribute('src');
    video.load();
}
function liveVideo(service, status) {
    const video = node('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('aria-label', service.name + 'のライブ映像');
    video.onplaying = () => { status.textContent = 'ライブ配信中'; };
    video.onerror = () => {
        status.textContent = 'ライブ映像を再生できません。空きチューナーとサーバーのエンコーダー設定を確認してください。';
    };
    video.onended = () => { status.textContent = 'ライブ配信が終了しました。'; };
    return video;
}
function playbackSessionId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
function supportsNativeHls(video) {
    const agent = navigator.userAgent;
    const appleMobile = /iPhone|iPad|iPod/.test(agent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const safari = /Version\/.*Safari\//.test(agent) && !/Chrome|Chromium|Edg\//.test(agent);
    return (appleMobile || safari) && Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
}
function startHls(video, id, params) {
    const path = './api/hls/' + id + '/index.m3u8';
    video.addEventListener('dvr-stop', () => {
        void fetch(path, { method: 'DELETE', keepalive: true }).catch(() => {});
    }, { once: true });
    video.src = path + '?' + params;
    void video.play().catch(() => {});
}
function startLiveVideo(video, service, container, profileName = guide.defaultLiveProfile) {
    const profiles = guide.liveProfiles || [];
    if (profiles.length) {
        const label = node('label', 'ライブ用プロファイル');
        const select = choose([['', '自動（NVEncC / FFmpeg）'],
            ...profiles.map(p => [p.name, p.name + '（' + p.encoder + '）'])], 'ライブ用プロファイル');
        select.value = profileName;
        select.onchange = () => {
            const selected = select.value;
            stopVideo(video, true);
            startLiveVideo(video, service, container, selected);
            container.querySelector('select[aria-label="ライブ用プロファイル"]')?.focus();
        };
        label.append(select);
        container.append(label);
        video.addEventListener('dvr-stop', () => label.remove(), { once: true });
    }
    const id = playbackSessionId();
    const track = video.textTracks[0] ?? video.addTextTrack('captions', '放送字幕', 'ja');
    let last = 0;
    let previous;
    let timer;
    const controller = new AbortController();
    async function poll() {
        try {
            const response = await fetch('./api/live-captions/' + id, { signal: controller.signal });
            const data = await response.json();
            if (data.error) {
                toggle.textContent = '字幕を取得できません';
                toggle.disabled = true;
                return;
            }
            for (const cue of data.cues) {
                if (cue.id <= last) continue;
                last = cue.id;
                if (previous && cue.start > previous.startTime) previous.endTime = Math.min(previous.endTime, cue.start);
                if (!cue.text || cue.start + cue.duration < video.currentTime) continue;
                previous = new VTTCue(cue.start, cue.start + cue.duration, cue.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;'));
                track.addCue(previous);
            }
            for (const cue of Array.from(track.cues || [])) if (cue.endTime < video.currentTime - 30) track.removeCue(cue);
        } catch { /* Retry while the player is open. */ }
        if (!controller.signal.aborted && track.mode === 'showing') timer = setTimeout(poll, 750);
    }
    const toggle = button('字幕', () => {
        const on = track.mode !== 'showing';
        track.mode = on ? 'showing' : 'hidden';
        toggle.setAttribute('aria-pressed', String(on));
        clearTimeout(timer);
        if (on) void poll();
    });
    track.mode = 'hidden';
    toggle.setAttribute('aria-pressed', 'false');
    container.append(toggle);
    video.addEventListener('dvr-stop', () => {
        controller.abort();
        clearTimeout(timer);
        for (const cue of Array.from(track.cues || [])) track.removeCue(cue);
        toggle.remove();
    }, { once: true });
    const nativeHls = supportsNativeHls(video);
    const params = new URLSearchParams(nativeHls ? { service: service.id } : { captions: id });
    if (profileName !== undefined) params.set('profile', profileName);
    if (nativeHls) startHls(video, id, params);
    else video.src = './api/watch/' + service.id + '?' + params;
}
function watch(service) {
    const status = node('p', 'ライブ配信を準備しています。', 'meta');
    status.setAttribute('role', 'status');
    const video = liveVideo(service, status);
    const external = node('details');
    const url = node('input');
    url.readOnly = true;
    url.value = new URL('./api/live/' + service.id, import.meta.url).href;
    url.setAttribute('aria-label', '外部プレーヤー用の視聴URL');
    url.onfocus = () => url.select();
    external.append(node('summary', '外部プレーヤーで開く'), url);
    details.replaceChildren(node('h2', service.name), video, status, external);
    dialog.showModal();
    startLiveVideo(video, service, details);
}
function stopTv() {
    if (!tv?.video) return;
    stopVideo(tv.video);
    tv.video.remove();
    tv.video = null;
    tv.service = null;
    tv.heading.textContent = 'ライブ視聴';
    tv.status.textContent = '放送局を選んでください。';
    tv.stop.hidden = true;
    tv.player.hidden = true;
    tv.layout.classList.remove('tv-watching');
}
function renderTv() {
    if (!tv) {
        const screen = node('div', undefined, 'tv-screen');
        const heading = node('h2', 'ライブ視聴');
        const status = node('p', '放送局を選んでください。', 'meta');
        status.setAttribute('role', 'status');
        const stop = button('局一覧に戻る', () => {
            const selected = tv.service;
            stopTv();
            updateTvStations('station:' + selected);
        });
        stop.hidden = true;
        const player = node('section', undefined, 'tv-player');
        player.hidden = true;
        const bar = node('div', undefined, 'tv-player-bar');
        bar.append(heading, stop);
        const program = node('div', undefined, 'tv-player-program');
        player.append(bar, screen, status, program);
        const waves = node('div', undefined, 'segments tv-waves');
        waves.setAttribute('role', 'group');
        waves.setAttribute('aria-label', '放送波');
        const stations = node('div', undefined, 'tv-stations');
        const selector = node('section', undefined, 'tv-selector');
        selector.append(waves, stations);
        if (guide.demo) selector.prepend(node('p', 'デモ番組を表示中です。ライブ視聴にはチューナー接続が必要です。', 'meta'));
        const layout = node('div', undefined, 'tv-layout');
        layout.append(player, selector);
        content.replaceChildren(layout);
        tv = { layout, player, screen, heading, status, stop, program, waves, stations, service: null, video: null, signature: '' };
    }
    updateTvStations();
}
function updateTvStations(focused = document.activeElement?.dataset.tvFocus) {
    const now = Date.now();
    const onAir = new Map();
    const next = new Map();
    for (const program of guide.programs) {
        if (program.start <= now && program.end > now) onAir.set(program.service, program);
        if (program.start > now && !next.has(program.service)) next.set(program.service, program);
    }
    const waves = [...new Set(visibleServices.map(s => s.channel?.type).filter(Boolean))];
    if (tvWave && !waves.includes(tvWave)) tvWave = '';
    const stations = visibleServices.filter(s => !tvWave || s.channel?.type === tvWave);
    const currentProgram = onAir.get(tv.service);
    const nextProgram = next.get(tv.service);
    const signature = JSON.stringify([waves, tvWave, tv.service, guide.demo, currentProgram, nextProgram, stations.map(s => [
        s.id, s.name, s.channel?.type, onAir.get(s.id), next.get(s.id)
    ])]);
    if (signature === tv.signature) return;
    tv.signature = signature;
    if (tv.service !== null) {
        tv.program.replaceChildren(node('h3', currentProgram?.title || '放送中の番組情報なし'));
        if (currentProgram) {
            tv.program.append(node('p', time(currentProgram.start) + '–' + time(currentProgram.end), 'meta'));
            if (currentProgram.description) tv.program.append(node('p', currentProgram.description));
        }
        if (nextProgram) tv.program.append(node('p', '次 ' + time(nextProgram.start) + '　' + nextProgram.title, 'meta'));
    }
    const controls = new Map();
    const waveLabel = type => type === 'GR' ? '地上波' : type;
    tv.waves.replaceChildren(...['', ...waves].map(wave => {
        const tab = button(waveLabel(wave) || 'すべて', () => {
            tvWave = wave;
            updateTvStations('wave:' + wave);
        });
        tab.setAttribute('aria-pressed', String(wave === tvWave));
        tab.dataset.tvFocus = 'wave:' + wave;
        controls.set(tab.dataset.tvFocus, tab);
        return tab;
    }));
    const cards = stations.map(service => {
        const current = onAir.get(service.id);
        const following = next.get(service.id);
        const card = button(undefined, () => {
            if (tv.service === service.id && tv.video && !tv.video.error && !tv.video.ended) return;
            stopTv();
            tv.service = service.id;
            tv.heading.textContent = service.name;
            tv.status.textContent = 'ライブ配信を準備しています。';
            tv.stop.hidden = false;
            tv.player.hidden = false;
            tv.layout.classList.add('tv-watching');
            tv.video = liveVideo(service, tv.status);
            tv.screen.append(tv.video);
            startLiveVideo(tv.video, service, tv.player);
            updateTvStations('station:' + service.id);
            tv.player.scrollIntoView({ block: 'nearest' });
        }, 'tv-station');
        card.disabled = guide.demo;
        card.setAttribute('aria-pressed', String(tv.service === service.id));
        card.dataset.tvFocus = 'station:' + service.id;
        controls.set(card.dataset.tvFocus, card);
        const label = node('span', undefined, 'tv-station-name');
        if (!guide.demo) {
            const logo = node('img', undefined, 'station-logo');
            logo.alt = '';
            logo.loading = 'lazy';
            logo.onerror = () => logo.remove();
            logo.src = './api/logos/' + service.id;
            label.append(logo);
        }
        label.append(node('strong', service.name));
        const timing = node('span', current ? time(current.start) + '–' + time(current.end) : '放送中の番組情報なし', 'meta');
        card.append(label, timing);
        if (current) card.append(node('span', current.title, 'tv-program-title'));
        const upcoming = node('span', following ? '次 ' + time(following.start) + '　' + following.title : '次の番組情報なし', 'meta tv-upcoming');
        card.append(upcoming);
        return card;
    });
    tv.stations.replaceChildren(...(cards.length ? cards : [node('p', '表示できる放送局がありません。', 'empty')]));
    controls.get(focused)?.focus({ preventScroll: true });
}
function enableGuideDrag(grid) {
    let drag;
    let suppressClick = false;
    grid.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'mouse' || event.button !== 0) return;
        suppressClick = false;
        const rect = grid.getBoundingClientRect();
        if (event.clientX >= rect.left + grid.clientWidth || event.clientY >= rect.top + grid.clientHeight) return;
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
            left: grid.scrollLeft, top: grid.scrollTop, active: false };
    });
    grid.addEventListener('pointermove', event => {
        if (drag?.id !== event.pointerId) return;
        if (!(event.buttons & 1)) {
            finishDrag(event);
            return;
        }
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.active) {
            if (Math.hypot(dx, dy) < 5) return;
            drag.active = true;
            suppressClick = true;
            grid.setPointerCapture(event.pointerId);
            grid.classList.add('guide-dragging');
        }
        grid.scrollTo(drag.left - dx, drag.top - dy);
    });
    function finishDrag(event) {
        if (drag?.id !== event.pointerId) return;
        drag = null;
        grid.classList.remove('guide-dragging');
        if (grid.hasPointerCapture(event.pointerId)) grid.releasePointerCapture(event.pointerId);
    }
    grid.addEventListener('pointerup', finishDrag);
    grid.addEventListener('pointercancel', finishDrag);
    grid.addEventListener('lostpointercapture', finishDrag);
    grid.addEventListener('pointerleave', event => {
        if (!drag?.active) finishDrag(event);
    });
    grid.addEventListener('dragstart', event => event.preventDefault());
    grid.addEventListener('click', event => {
        if (suppressClick && event.detail && (!event.pointerType || event.pointerType === 'mouse')) {
            event.stopPropagation();
            event.preventDefault();
            suppressClick = false;
        }
    }, true);
}
function renderGuide(timelineStart) {
    const tools = node('div', undefined, 'toolbar guide-tools');
    const search = node('input');
    search.type = 'search';
    search.placeholder = '番組名・説明を検索';
    search.setAttribute('aria-label', search.placeholder);
    search.value = keyword;
    const waves = node('div', undefined, 'segments');
    waves.setAttribute('role', 'group');
    waves.setAttribute('aria-label', '放送波');
    const types = new Set(visibleServices.map(s => s.channel?.type).filter(Boolean));
    if (channelType && !types.has(channelType)) channelType = '';
    for (const type of ['', ...types]) {
        const tab = button(type === '' ? 'すべて' : type === 'GR' ? '地上波' : type, () => {
            channelType = type;
            try { localStorage.setItem(guideWaveKey, type); } catch {}
            guideScroll.left = 0;
            for (const item of waves.children) item.setAttribute('aria-pressed', String(item === tab));
            populate();
        });
        tab.setAttribute('aria-pressed', String(channelType === type));
        waves.append(tab);
    }
    const dates = node('div', undefined, 'date-strip');
    dates.setAttribute('role', 'group');
    dates.setAttribute('aria-label', '放送日');
    const today = dayStart(Date.now());
    function selectDay(value) {
        from = Math.max(value, dayStart(Date.now()));
        guideScroll.top = 0;
        return load();
    }
    dates.append(button('‹', () => selectDay(from - day)));
    dates.firstElementChild.setAttribute('aria-label', '前日');
    dates.firstElementChild.disabled = from <= today;
    const first = Math.max(today, from - 6 * day);
    const datePicker = choose(Array.from({ length: 7 }, (_, i) => {
        const value = first + i * day;
        return [value, date(value)];
    }), '放送日');
    datePicker.value = from;
    datePicker.onchange = () => selectDay(Number(datePicker.value)).catch(error => message(error.message));
    dates.append(datePicker);
    dates.append(button('›', () => selectDay(from + day)));
    dates.lastElementChild.setAttribute('aria-label', '翌日');
    const legend = node('details', undefined, 'genre-legend');
    legend.append(node('summary', 'ジャンル'));
    const keys = node('ul');
    legend.append(keys);
    tools.append(waves, dates, button('現在', () => selectDay(dayStart(Date.now()))), search, legend, document.querySelector('#sync'));
    const results = node('div');
    content.replaceChildren(tools, results);
    function populate() {
        const end = timelineStart + day;
        const toPixels = duration => duration / hour * pixelsPerHour;
        const services = visibleServices.filter(s => !channelType || s.channel?.type === channelType);
        const term = keyword.trim().normalize('NFKC').toLowerCase();
        const filtered = guide.programs.filter(p => p.end > timelineStart && p.start < end && services.some(s => s.id === p.service) &&
            (p.title + ' ' + p.description).normalize('NFKC').toLowerCase().includes(term));
        const reserved = new Map(state.reservations.filter(r => ['scheduled', 'recording', 'completed'].includes(r.status)).map(r => [r.programId, r]));
        results.replaceChildren();
        keys.replaceChildren();
        legend.hidden = !filtered.length || Boolean(term);
        if (!filtered.length) return results.append(node('p', '表示できる番組がありません。', 'empty'));
        if (term) {
            const list = node('div', undefined, 'list');
            for (const p of filtered) {
                const row = node('div', undefined, 'row');
                row.append(node('span', date(p.start) + ' ' + time(p.start) + '　' + channel(p.service) + '　' + p.title), button(reserved.has(p.id) ? '予約・番組詳細' : '番組詳細', () => programDetails(p)));
                list.append(row);
            }
            return results.append(list);
        }
        const grid = node('div', undefined, 'guide');
        grid.style.setProperty('--channels', services.length);
        grid.style.setProperty('--hour-height', pixelsPerHour + 'px');
        grid.tabIndex = 0;
        grid.setAttribute('aria-label', '番組表 ' + date(from));
        const axis = node('div', undefined, 'time-axis');
        const hours = node('div', undefined, 'hours');
        for (let tick = timelineStart; tick < end; tick = (Math.floor(tick / hour) + 1) * hour) {
            const label = node('time', tick > timelineStart && tick === dayStart(tick) ? date(tick) + ' ' + time(tick) : time(tick));
            label.dataset.period = Math.floor(((Math.floor(tick / hour) + 9) % 24) / 3);
            label.style.height = toPixels(Math.min(end, (Math.floor(tick / hour) + 1) * hour) - tick) + 'px';
            hours.append(label);
        }
        axis.append(node('div', 'JST', 'channel-header'), hours);
        grid.append(axis);
        for (const service of services) {
            const column = node('div', undefined, 'channel');
            const header = node('div', undefined, 'channel-header');
            if (!guide.demo) {
                const logo = node('img', undefined, 'station-logo');
                logo.alt = '';
                logo.loading = 'lazy';
                logo.onerror = () => logo.remove();
                logo.src = './api/logos/' + service.id;
                header.append(logo);
            }
            const station = node('strong', service.name);
            station.title = service.name;
            header.append(station);
            if (!guide.demo) {
                const play = button('▶', () => watch(service), 'guide-live');
                play.title = 'ライブ視聴';
                play.setAttribute('aria-label', service.name + 'をライブ視聴');
                header.append(play);
            }
            const timeline = node('div', undefined, 'timeline');
            timeline.style.height = toPixels(end - timelineStart) + 'px';
            timeline.style.backgroundPositionY = toPixels(from - timelineStart) + 'px';
            for (const p of filtered.filter(p => p.service === service.id)) {
                const top = toPixels(Math.max(timelineStart, p.start) - timelineStart);
                const height = toPixels(Math.min(end, p.end) - timelineStart) - top;
                const item = button('', () => programDetails(p), 'program genre-color');
                const genre = mainGenre(p);
                item.dataset.genre = genre;
                item.style.top = top + 'px';
                item.style.height = Math.max(2, height - 2) + 'px';
                if (height < 48) item.classList.add('program-compact');
                const reservation = reserved.get(p.id);
                const label = reservation ? reservation.conflict ? '競合' : statuses[reservation.status] : '';
                item.dataset.reservation = reservation?.conflict ? 'conflict' : reservation ? 'reserved' : '';
                item.setAttribute('aria-label', [time(p.start), p.title, genreName(genre), label].filter(Boolean).join(' '));
                const info = node('div', undefined, 'program-info');
                info.append(node('time', time(p.start)));
                if (label) info.append(node('span', label, 'program-status'));
                item.append(info, node('strong', p.title), node('span', p.description, 'program-description'));
                timeline.append(item);
            }
            if (timelineStart > from) {
                const marker = node('div', undefined, 'now-line');
                marker.style.top = '0px';
                marker.setAttribute('aria-hidden', 'true');
                timeline.append(marker);
            }
            column.append(header, timeline);
            grid.append(column);
        }
        const displayed = new Set(filtered.map(mainGenre));
        for (const id of [...displayed].sort((a, b) => a - b)) {
            const key = node('li', genreName(id), 'genre-color');
            key.dataset.genre = id;
            keys.append(key);
        }
        results.append(grid);
        enableGuideDrag(grid);
        grid.scrollTo(guideScroll.left, guideScroll.top);
        grid.addEventListener('scroll', () => {
            if (grid.isConnected) guideScroll = { left: grid.scrollLeft, top: grid.scrollTop };
        }, { passive: true });
    }
    search.oninput = () => { keyword = search.value; populate(); };
    populate();
}
const recordingPreferencesKey = 'dvr-recording-preferences';
const recordingGroupsKey = 'dvr-recording-groups';
let recordingPreferences = {};
let recordingGroups = [];
try { recordingPreferences = JSON.parse(localStorage.getItem(recordingPreferencesKey)) || {}; } catch {}
try {
    const saved = JSON.parse(localStorage.getItem(recordingGroupsKey));
    if (Array.isArray(saved)) recordingGroups = saved.filter(group => typeof group?.id === 'string' && typeof group.name === 'string');
} catch {}
function saveRecordingGroups(groups) {
    localStorage.setItem(recordingGroupsKey, JSON.stringify(groups));
    recordingGroups = groups;
}
function saveRecordingPreference(id, changes) {
    recordingPreferences[id] = { ...recordingPreferences[id], ...changes };
    try { localStorage.setItem(recordingPreferencesKey, JSON.stringify(recordingPreferences)); } catch {}
}
function resumePosition(id) {
    const saved = recordingPreferences[id];
    return saved?.duration > 0 && saved.position > 0 && saved.position < saved.duration - 2 ? saved.position : 0;
}
function playRecording(row, path, fromStart = false) {
    const title = node('h2', row.title);
    const progress = node('p', '録画の再生を準備しています。', 'meta');
    progress.setAttribute('role', 'status');
    details.replaceChildren(title, progress);
    if (!dialog.open) dialog.showModal();
    const video = node('video');
    video.controls = true;
    video.playsInline = true;
    const resume = fromStart ? 0 : resumePosition(row.id);
    const nativeHls = supportsNativeHls(video);
    let usingHls = nativeHls && !row.mp4;
    let offset = row.mp4 ? 0 : Math.floor(resume);
    let track;
    function playHls() {
        startHls(video, playbackSessionId(), new URLSearchParams({
            recording: row.id, format: row.mp4 ? 'mp4' : 'ts', start: offset
        }));
    }
    const estimatedDuration = Math.max(0, (row.end - row.start) / 1000);
    let lastSaved = -1;
    function savePosition(force = false) {
        const duration = !usingHls && Number.isFinite(video.duration) ? offset + video.duration : estimatedDuration;
        const position = offset + video.currentTime;
        if (!(duration > 0) || video.readyState === 0) return;
        if (!force && Math.abs(position - lastSaved) < 5) return;
        lastSaved = position;
        saveRecordingPreference(row.id, { position, duration, watchedAt: Date.now() });
    }
    video.addEventListener('loadedmetadata', () => {
        if (row.mp4 && !usingHls && resume < video.duration - 2) video.currentTime = resume;
        progress.hidden = true;
        void video.play().catch(() => {});
    });
    video.addEventListener('timeupdate', () => savePosition());
    for (const event of ['pause', 'seeked', 'ended']) video.addEventListener(event, () => savePosition(true));
    video.addEventListener('error', () => {
        if (video.hasAttribute('src')) {
            progress.hidden = false;
            if (nativeHls && row.mp4 && !usingHls) {
                usingHls = true;
                offset = Math.floor(Math.max(resume, video.currentTime || 0));
                if (track) track.src = './api/' + path + '/captions?start=' + offset;
                progress.textContent = '互換形式で録画の再生を準備しています。';
                playHls();
                return;
            }
            progress.textContent = '録画を再生できませんでした。';
        }
    });
    details.append(node('p', row.importedVideo ? '登録動画 · ' + row.importedVideo.name :
        date(row.start) + ' ' + time(row.start) + '　' + channel(row.service), 'meta'));
    if (row.description) details.append(node('p', row.description, 'meta'));
    details.append(video);
    if (row.ts || row.captions) {
        track = node('track');
        track.kind = 'captions';
        track.label = '放送字幕';
        track.srclang = 'ja';
        track.src = './api/' + path + '/captions?start=' + offset;
        const captionStatus = node('p', '', 'meta');
        captionStatus.setAttribute('role', 'status');
        const toggle = button('字幕', () => {
            const on = track.track.mode !== 'showing';
            track.track.mode = on ? 'showing' : 'disabled';
            toggle.setAttribute('aria-pressed', String(on));
            captionStatus.textContent = on && track.readyState !== 2 ? '字幕を準備しています。' : '';
            if (on && track.readyState === 2 && !track.track.cues?.length) captionStatus.textContent = '表示できる字幕がありません。';
        });
        toggle.setAttribute('aria-pressed', 'false');
        track.onload = () => {
            captionStatus.textContent = track.track.mode === 'showing' && !track.track.cues?.length ? '表示できる字幕がありません。' : '';
        };
        track.onerror = () => {
            track.track.mode = 'disabled';
            toggle.setAttribute('aria-pressed', 'false');
            captionStatus.textContent = '字幕を読み込めませんでした。';
        };
        video.append(track);
        details.append(toggle, captionStatus);
    }
    if (usingHls) playHls();
    else {
        video.src = './api/' + path + (row.mp4 ? '/mp4' : '/stream?start=' + offset);
        if (nativeHls) void video.play().catch(() => {});
    }
}
let recordingFilter = '';
let recordingTab = 'all';
let recordingGroup = '';
function assignedRecordingGroup(id) {
    const group = recordingPreferences[id]?.group;
    return recordingGroups.some(item => item.id === group) ? group : '';
}

function showRecordingGroups() {
    const list = node('div', undefined, 'list recording-group-list');
    const form = node('form', undefined, 'actions');
    const name = node('input');
    name.maxLength = 80;
    name.required = true;
    name.placeholder = 'グループ名';
    name.setAttribute('aria-label', 'グループ名');
    const status = node('p', '', 'warning');
    status.setAttribute('role', 'status');
    form.append(name, node('button', '追加', 'primary'));
    function validate(value, id) {
        const normalized = value.trim();
        if (!normalized) throw new Error('グループ名を入力してください。');
        if (recordingGroups.some(group => group.id !== id && group.name === normalized)) throw new Error('同じ名前のグループがあります。');
        return normalized;
    }
    function showGroups() {
        list.replaceChildren();
        for (const group of recordingGroups) {
            const row = node('div', undefined, 'actions');
            const edit = node('input');
            edit.maxLength = 80;
            edit.value = group.name;
            edit.setAttribute('aria-label', group.name + 'の名前');
            row.append(edit, button('名前を保存', () => {
                const value = validate(edit.value, group.id);
                saveRecordingGroups(recordingGroups.map(item => item === group ? { ...item, name: value } : item));
                status.textContent = '';
                showGroups();
                renderReservations();
            }), button('削除', () => {
                if (!confirm('グループ「' + group.name + '」を削除しますか？ グループ内の動画は未分類になります。')) return;
                saveRecordingGroups(recordingGroups.filter(item => item !== group));
                if (recordingGroup === group.id) recordingGroup = '';
                status.textContent = '';
                showGroups();
                renderReservations();
            }));
            list.append(row);
        }
    }
    form.onsubmit = event => {
        event.preventDefault();
        try {
            saveRecordingGroups([...recordingGroups, { id: playbackSessionId(), name: validate(name.value) }]);
            name.value = '';
            status.textContent = '';
            showGroups();
            renderReservations();
        } catch (error) { status.textContent = error.message; }
    };
    showGroups();
    details.replaceChildren(node('h2', 'マイリストのグループ'), form, list, status);
    dialog.showModal();
}
function logoRegionFields(row, path, format, original = false) {
    const fields = node('fieldset', undefined, 'rule-days');
    fields.append(node('legend', 'ロゴ消し（任意）'),
        node('p', '画像上でロゴを囲むか、座標を入力してください。', 'meta'));
    const preview = node('div', undefined, 'logo-preview');
    const image = node('img');
    image.alt = 'ロゴ範囲選択用の録画映像';
    image.draggable = false;
    image.hidden = true;
    const box = node('div', undefined, 'logo-preview-box');
    box.hidden = true;
    preview.append(image, box);
    const controls = node('div', undefined, 'actions logo-preview-controls');
    const timeLabel = node('label', '録画開始からの秒数');
    const offset = node('input');
    offset.type = 'number';
    offset.min = '0';
    offset.max = '604800';
    offset.value = '5';
    timeLabel.append(offset);
    const status = node('p', '', 'meta');
    status.setAttribute('role', 'status');
    const owner = row.importedVideo ? 'この動画' : 'この局';
    const remember = button(owner + 'の範囲を記憶', async () => {
        try {
            const region = read();
            if (!region) throw new Error('ロゴ範囲を選択してください。');
            remember.disabled = true;
            await api(regionPath(), 'PUT', { region });
            status.textContent = owner + 'の範囲をサーバーに記憶しました。';
        } catch (error) { status.textContent = error.message; }
        finally { remember.disabled = image.hidden; }
    });
    remember.disabled = true;
    controls.append(timeLabel, button('画像を表示', loadImage), remember);
    fields.append(controls, preview, status);
    const inputs = new Map();
    for (const [key, title] of [['x', '左から'], ['y', '上から'], ['w', '幅'], ['h', '高さ']]) {
        const label = node('label', title);
        const input = node('input');
        input.type = 'number';
        input.min = '2';
        input.max = '8192';
        label.append(input);
        fields.append(label);
        inputs.set(key, input);
        input.addEventListener('input', draw);
    }
    function storageKey() {
        return 'kreuzentv.logo.' + (row.importedVideo ? row.id : row.service) + '.' + format + '.' + image.naturalWidth + 'x' + image.naturalHeight;
    }
    function regionPath() {
        return path + '/logo-region?' + new URLSearchParams({ format, width: image.naturalWidth, height: image.naturalHeight });
    }
    function loadImage() {
        if (!offset.value || !offset.checkValidity()) return;
        image.hidden = true;
        box.hidden = true;
        remember.disabled = true;
        status.textContent = '画像を取得しています。';
        image.src = './api/' + path + '/logo-preview?' + new URLSearchParams({
            format, start: offset.value, ...(original ? { source: 'original' } : {})
        });
    }
    image.onload = async () => {
        image.hidden = false;
        status.textContent = '';
        const endpoint = regionPath();
        const key = storageKey();
        draw();
        try {
            const { region } = await api(endpoint);
            if (image.hidden || regionPath() !== endpoint) return;
            status.textContent = region ? 'この解像度のロゴ範囲はサーバーに保存済みです。' :
                'この解像度のロゴ範囲はサーバーに未保存です。';
            let saved = region;
            if (!saved) {
                try { saved = JSON.parse(localStorage.getItem(key)); }
                catch { /* Browser storage may be unavailable. */ }
            }
            if (saved && [...inputs.values()].every(input => !input.value)) {
                for (const [key, input] of inputs) input.value = saved[key];
                status.textContent = region ? owner + 'の共有範囲を読み込みました。' :
                    'このブラウザーの範囲を読み込みました。「' + owner + 'の範囲を記憶」で共有できます。';
            }
        } catch (error) {
            if (!image.hidden && regionPath() === endpoint) status.textContent = error.message;
        }
        if (image.hidden || regionPath() !== endpoint) return;
        remember.disabled = false;
        draw();
    };
    image.onerror = () => { status.textContent = '画像を取得できません。別の秒数を指定してください。'; };
    function read() {
        if ([...inputs.values()].every(input => input.value === '')) return undefined;
        if ([...inputs.values()].some(input => !input.value || !input.checkValidity())) {
            throw new Error('ロゴ範囲の4項目すべてに2以上の整数を入力してください。');
        }
        const region = Object.fromEntries([...inputs].map(([key, input]) => [key, input.valueAsNumber]));
        if (!image.hidden && (region.x + region.w > image.naturalWidth - 2 || region.y + region.h > image.naturalHeight - 2)) {
            throw new Error('ロゴ範囲は画像の境界から2ピクセル以上空けてください。');
        }
        return region;
    }
    function draw() {
        box.hidden = true;
        if (image.hidden) return;
        try {
            const region = read();
            if (!region) return;
            Object.assign(box.style, {
                left: region.x / image.naturalWidth * 100 + '%', top: region.y / image.naturalHeight * 100 + '%',
                width: region.w / image.naturalWidth * 100 + '%', height: region.h / image.naturalHeight * 100 + '%'
            });
            box.hidden = false;
        } catch { /* Incomplete coordinates cannot be drawn. */ }
    }
    function point(event) {
        const rect = image.getBoundingClientRect();
        return ['x', 'y'].map((axis, i) => {
            const size = i ? image.naturalHeight : image.naturalWidth;
            const ratio = i ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width;
            return Math.max(2, Math.min(size - 2, Math.round(ratio * size)));
        });
    }
    let drag;
    image.onpointerdown = event => {
        if (!event.isPrimary || event.button !== 0) return;
        image.setPointerCapture(event.pointerId);
        drag = point(event);
    };
    image.onpointermove = event => {
        if (!drag || !image.hasPointerCapture(event.pointerId)) return;
        const [x, y] = point(event);
        const values = [Math.min(x, drag[0]), Math.min(y, drag[1]), Math.abs(x - drag[0]), Math.abs(y - drag[1])];
        [...inputs.values()].forEach((input, i) => { input.value = values[i]; });
        draw();
    };
    image.onlostpointercapture = () => { drag = null; };
    loadImage();
    return { fields, read };
}

function editEncodeProfile() {
    const label = node('label', 'エンコードプロファイル');
    const profile = choose([['', '録画設定に従う（未指定ならサーバーの既定）'],
        ...(state.encodeProfiles || []).map(p => [p.name, p.name])], 'エンコードプロファイル');
    label.append(profile);
    return { label, profile };
}

function drawLogoData(canvas, { width, height, rgba }) {
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(
        Uint8ClampedArray.from(atob(rgba), c => c.charCodeAt(0)), width, height), 0, 0);
}

function showLogoExtraction(row, path) {
    const endpoint = path + '/logo-extract';
    const logo = logoRegionFields(row, path, row.importedVideo?.format ?? 'ts', Boolean(row.importedVideo));
    const configuration = node('fieldset', undefined, 'logo-extract-settings');
    const start = node('input');
    start.type = 'number';
    start.min = '0';
    start.max = '604800';
    start.value = '0';
    const startLabel = node('label', '解析を始める秒数 ');
    startLabel.append(start);
    const station = choose(row.importedVideo ? [['', '放送局を選択'],
        ...visibleServices.map(service => [service.id, service.name])] : [[row.service, channel(row.service)]], '登録先の放送局');
    const stationLabel = node('label', '登録先の放送局 ');
    stationLabel.append(station);
    const image = node('canvas', undefined, 'logo-data-image');
    image.setAttribute('role', 'img');
    image.setAttribute('aria-label', '抽出した局ロゴ');
    const result = node('div', undefined, 'logo-extract-result');
    result.hidden = true;
    const status = node('p', '', 'meta');
    status.setAttribute('role', 'status');
    let timer, token;
    const register = button('LGDを登録', async () => {
        try {
            if (!station.value) throw new Error('登録先の放送局を選択してください。');
            const service = Number(station.value);
            const { logos } = await api('logo-data');
            const replace = logos.some(logo => logo.service === service);
            if (replace && !confirm('「' + station.selectedOptions[0].text + '」の登録済みロゴを差し替えますか？')) return;
            await api(endpoint, 'PUT', { service, replace, token });
            await refresh();
        } catch (error) { status.textContent = error.message; }
    }, 'primary');
    result.append(image, stationLabel, register);
    async function refresh() {
        try {
            const job = await api(endpoint);
            if (!status.isConnected) return;
            const running = job.status === 'running';
            configuration.disabled = running;
            result.hidden = job.status !== 'ready';
            if (running) {
                status.textContent = job.phase + (Number.isFinite(job.progress) ? ' · ' + Math.floor(job.progress) + '%' : '');
                timer = setTimeout(refresh, 1200);
            } else if (job.status === 'ready') {
                token = job.token;
                drawLogoData(image, job.preview);
                const { width, height } = job.preview;
                status.textContent = width + ' × ' + height + ' px · 画像を確認してから登録してください。';
            } else {
                status.textContent = job.error ?? (job.status === 'registered' ? 'LGDを登録しました。ロゴ消しで使用できます。' : '');
            }
        } catch (error) {
            if (status.isConnected) {
                configuration.disabled = false;
                status.textContent = error.message;
            }
        }
    }
    const extract = button('抽出を開始', async () => {
        try {
            if (!start.value || !start.checkValidity()) throw new Error('解析を始める秒数を確認してください。');
            await api(endpoint, 'POST', { start: Number(start.value), region: logo.read() });
            clearTimeout(timer);
            await refresh();
        } catch (error) { status.textContent = error.message; }
    }, 'primary');
    configuration.append(startLabel, logo.fields, extract);
    dialog.addEventListener('close', () => clearTimeout(timer), { once: true });
    details.replaceChildren(node('h2', row.title), node('p', 'ロゴを抽出', 'status'),
        node('p', '指定位置から最長6分を解析します。ロゴ範囲を空欄にすると自動で検出します。', 'meta'),
        configuration, status, result, button('録画詳細に戻る', () => {
            clearTimeout(timer);
            recordingDetails(row, path);
        }));
    void refresh();
}

function logoEditFields(row, path, format, original = false, optional = false) {
    const fields = node('div', undefined, 'logo-edit-fields');
    const mode = choose([['rectangle', '範囲指定'], ['lgd', 'LGD（QSVEncC）'],
        ...(state.canAmatsukazeDelogo ? [['amatsukaze', 'Amatsukaze（表示区間・フェード解析）']] : []),
        ...(optional ? [['none', 'ロゴ消しなし']] : [])], 'ロゴ消し方式');
    const modeLabel = node('label', 'ロゴ消し方式 ');
    modeLabel.append(mode);
    const picker = choose([['', 'ロゴデータを選択']], 'LGDロゴ');
    const dataLabel = node('label', '登録済みロゴ ');
    dataLabel.append(picker);
    const note = node('p', 'LGDは元動画に適用します。CMカットも行う場合は同じ変換で指定してください。', 'meta');
    const rectangle = logoRegionFields(row, path, format, original);
    let changed = false;
    let logos = [];
    function update() {
        const previous = picker.value;
        const eligible = logos.filter(logo => mode.value !== 'amatsukaze' || logo.amatsukaze);
        picker.replaceChildren(...choose([['', 'ロゴデータを選択'], ...eligible.map(logo => [
            logo.service + '.' + logo.format, logo.name + '（' + logo.format.toUpperCase() + '）'
        ])], '').options);
        if (previous && [...picker.options].some(option => option.value === previous)) picker.value = previous;
        else {
            const station = eligible.find(logo => logo.service === row.service);
            if (station) picker.value = station.service + '.' + station.format;
        }
        dataLabel.hidden = note.hidden = !['lgd', 'amatsukaze'].includes(mode.value);
        note.textContent = mode.value === 'amatsukaze' ?
            '表示区間とフェードを解析してからロゴを消します。映像の出力にはQSVEncC、音声の処理にはAmatsukazeを使います。' :
            'LGDは元動画に適用します。CMカットも行う場合は同じ変換で指定してください。';
        rectangle.fields.hidden = mode.value !== 'rectangle';
    }
    mode.onchange = () => { changed = true; update(); };
    fields.append(modeLabel, dataLabel, note, rectangle.fields);
    update();
    void api('logo-data').then(data => {
        logos = data.logos;
        if (!changed) {
            const defaultName = row.options?.encodeProfile || state.defaultEncodeProfile;
            const profile = state.encodeProfiles?.find(item => item.name === defaultName);
            const applicable = row.importedVideo ? logos : logos.filter(logo => logo.service === row.service);
            if (profile?.encoder === 'QSVEncC' && state.canAmatsukazeDelogo && applicable.some(logo => logo.amatsukaze)) {
                mode.value = 'amatsukaze';
            } else if (!row.importedVideo && profile?.encoder === 'QSVEncC' && applicable.length) {
                mode.value = 'lgd';
            }
        }
        update();
    }).catch(() => {});
    return {
        fields,
        read() {
            if (mode.value === 'none') return undefined;
            if (!['lgd', 'amatsukaze'].includes(mode.value)) return rectangle.read();
            if (!picker.value && optional && !changed) return undefined;
            if (!picker.value) throw new Error('登録済みのLGDロゴを選択してください。');
            return { lgd: picker.value, ...(mode.value === 'amatsukaze' ? { engine: 'amatsukaze' } : {}) };
        }
    };
}

function showLogoRemoval(row, path) {
    const logo = logoEditFields(row, path, row.mp4 ? 'mp4' : 'ts');
    const { label, profile } = editEncodeProfile();
    const status = node('p', '', 'meta');
    status.setAttribute('role', 'status');
    details.replaceChildren(node('h2', row.title), node('p', row.importedVideo ?
        '編集結果を別のMP4に保存します。' : row.mp4 ?
        '変換に成功すると編集済みMP4に差し替えます。' : '編集結果をMP4に保存します。', 'meta'),
        logo.fields, label, status,
        button('録画詳細に戻る', () => recordingDetails(row, path)),
        button('ロゴを消してMP4に変換', async () => {
            try {
                const region = logo.read();
                if (!region) throw new Error('ロゴ範囲を入力してください。');
                await api(path + '/encode', 'POST', { logo: region, encodeProfile: profile.value || undefined });
                if (dialog.open) dialog.close();
                message('ロゴ消し付きの変換を開始しました。');
            } catch (error) { status.textContent = error.message; }
        }, 'primary'));
}
function showCommercials(row, path) {
    const logo = logoEditFields(row, path, row.importedVideo?.format ?? 'ts', Boolean(row.importedVideo), true);
    const progress = node('p', 'ロゴ消し方式を確認してからCM解析へ進めます。CMカットだけの場合は「ロゴ消しなし」を選んでください。', 'meta');
    progress.setAttribute('role', 'status');
    const start = button('CM解析へ進む', async () => {
        start.disabled = true;
        try {
            logo.read();
            await loadCommercialCandidates(row, path, logo, progress);
            if (start.isConnected) start.remove();
        } catch (error) {
            progress.textContent = error.message;
            start.disabled = false;
        }
    }, 'primary');
    details.replaceChildren(node('h2', row.title), logo.fields, progress, start,
        button('録画詳細に戻る', () => recordingDetails(row, path)));
}

async function loadCommercialCandidates(row, path, logo, progress) {
    const meter = node('progress');
    meter.max = 100;
    meter.setAttribute('aria-label', 'CM候補検出の進捗');
    progress.textContent = 'CM解析の状態を確認しています。';
    progress.after(meter);
    try {
        let result = await api(path + '/commercials');
        if (!progress.isConnected || !dialog.open) return;
        if (result.status === 'idle' || result.status === 'failed') result = await api(path + '/commercials', 'POST', {});
        while (result.status === 'running' && progress.isConnected && dialog.open) {
            const checking = result.phase === 'checking';
            const percent = !checking && Number.isFinite(result.progress) ? result.progress : null;
            if (percent === null) meter.removeAttribute('value');
            else meter.value = percent;
            const elapsed = Math.max(0, Math.floor((Date.now() - (result.startedAt || Date.now())) / 1000));
            progress.textContent = (result.detector ? result.detector + ' · ' : '') +
                (result.phase === 'generating-logo' ? '録画からこの局のロゴを生成しています。' :
                result.phase === 'chapters' ? '無音・シーン切替を検出しています。' :
                result.phase === 'logo' ? '局ロゴの表示区間を検出しています。' : checking ? '検出結果を確認しています。' :
                'CM候補を検出しています。' + (percent === null ? '' : ' ' + percent + '%')) +
                ' 経過 ' + Math.floor(elapsed / 60) + '分' + elapsed % 60 + '秒';
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (!progress.isConnected || !dialog.open) return;
            result = await api(path + '/commercials');
        }
        if (!progress.isConnected || !dialog.open) return;
        meter.remove();
        if (result.status === 'failed') throw new Error(result.error);
        progress.textContent = (result.detector ? result.detector + ' · ' : '') +
            (result.logoMismatch ? '局ロゴが映像と一致しなかったためComskipで検出しました。 ' :
                result.logoAnalysisFailed ? '局ロゴを使ったCM解析が失敗したためComskipで検出しました。 ' :
                result.logoGenerated ? 'この局のロゴを生成して保存しました。 ' :
                result.logoGenerationFailed ? '局ロゴを生成できなかったためComskipで検出しました。 ' : '') +
            (result.cuts.length ? '検出したCM候補は' + result.cuts.length + '件です。' : 'CM候補は見つかりませんでした。') +
            ' 候補の選択や手動入力で、削除する区間を指定できます。時刻は元の録画TSの開始からの経過時間です。' +
            (row.mp4 ? ' 変換成功後に既存のMP4を差し替えます。' : '');
        const ranges = node('fieldset', undefined, 'rule-days');
        ranges.append(node('legend', 'CM候補'));
        const stamp = seconds => new Date(Math.round(seconds * 1000)).toISOString().slice(11, 21);
        for (const [i, cut] of result.cuts.entries()) {
            const check = node('input');
            check.type = 'checkbox';
            check.value = i;
            const label = node('label');
            label.append(check, stamp(cut.start) + '–' + stamp(cut.end));
            ranges.append(label);
        }
        const manual = node('fieldset', undefined, 'rule-days');
        manual.append(node('legend', '手動で指定する区間'));
        const intervals = [];
        const addInterval = () => {
            const fields = node('div', undefined, 'actions');
            const inputs = ['開始（秒）', '終了（秒）'].map(title => {
                const label = node('label', title);
                const input = node('input');
                input.type = 'number';
                input.min = '0';
                input.max = String(result.duration);
                input.step = 'any';
                label.append(input);
                fields.append(label);
                return input;
            });
            intervals.push(inputs);
            fields.append(button('区間を削除', () => {
                intervals.splice(intervals.indexOf(inputs), 1);
                fields.remove();
            }));
            manual.append(fields);
        };
        manual.append(button('手動区間を追加', addInterval));
        const { label, profile } = editEncodeProfile();
        const convert = button('CMカット・ロゴ消しを実行', async () => {
            const selected = [...ranges.querySelectorAll(':checked')].map(input => Number(input.value));
            convert.disabled = true;
            try {
                const region = logo.read();
                const custom = intervals.map(([start, end]) => {
                    if (!start.value || !end.value || !start.checkValidity() || !end.checkValidity() ||
                        start.valueAsNumber >= end.valueAsNumber) throw new Error('手動区間の開始と終了を確認してください。');
                    return { start: start.valueAsNumber, end: end.valueAsNumber };
                });
                if (!selected.length && !custom.length) throw new Error('カットする区間を指定してください。');
                await api(path + '/commercials', 'POST', {
                    apply: selected, manual: custom, logo: region, encodeProfile: profile.value || undefined
                });
                if (progress.isConnected && dialog.open) dialog.close();
                message(region ? 'CMカットとロゴ消しを開始しました。' : 'CMカット付きの変換を開始しました。');
            } catch (error) { progress.textContent = error.message; }
            finally { convert.disabled = false; }
        }, 'primary');
        if (result.cuts.length) details.append(ranges);
        details.append(manual, label, convert);
    } finally { meter.remove(); }
}
function showReencode(row, path) {
    const label = node('label', 'エンコードプロファイル');
    const profile = choose([['', 'サーバーの既定'], ...state.encodeProfiles.map(p => [p.name, p.name])], 'エンコードプロファイル');
    label.append(profile);
    const status = node('p', '', 'meta');
    status.setAttribute('role', 'status');
    const start = button('再変換を開始', async () => {
        start.disabled = true;
        try {
            await api(path + '/encode', 'POST', { reencode: true, encodeProfile: profile.value });
            message('再変換を開始しました。');
            if (status.isConnected) recordingDetails({ ...row, encoding: true }, path);
            await load();
        } catch (error) { status.textContent = error.message; }
        finally { start.disabled = false; }
    }, 'primary');
    details.replaceChildren(node('h2', row.title), label, node('p', row.mp4 ?
        '現在のMP4を使い、成功すると新しいMP4に差し替えます。' : '録画TSから新しいMP4を作成します。', 'meta'),
        status, button('録画詳細に戻る', () => recordingDetails(row, path)), start);
}

function confirmRecordingDeletion(row, path) {
    const form = node('form', undefined, 'recording-delete-form');
    const group = node('fieldset', undefined, 'rule-days');
    group.append(node('legend', 'ストレージから削除するファイル'));
    const original = node('input');
    const converted = node('input');
    const imported = row.importedVideo;
    for (const [check, available, title] of [
        [original, imported ? row.hasOriginalVideo : row.ts,
            imported ? '元ファイル（' + (imported.name.split('.').at(-1) || imported.format).toUpperCase() + '）' : '元の録画ファイル（TS）'],
        [converted, imported ? row.hasEditedVideo : row.mp4, '変換後のファイル（MP4）']
    ]) {
        check.type = 'checkbox';
        if (!available) continue;
        const label = node('label');
        label.append(check, title);
        group.append(label);
    }
    const submit = node('button', '削除を実行', 'primary');
    const status = node('p', '', 'warning');
    status.setAttribute('role', 'status');
    const actions = node('div', undefined, 'actions');
    actions.append(button('戻る', () => recordingDetails(row, path)), submit);
    form.append(node('p', 'この項目を録画一覧から外します。チェックを入れたファイルはストレージから削除します。'));
    if (group.querySelector('input')) form.append(group);
    form.append(actions, status);
    form.onsubmit = async event => {
        event.preventDefault();
        submit.disabled = true;
        const query = new URLSearchParams({ deleteOriginal: Number(original.checked), deleteConverted: Number(converted.checked) });
        try {
            await mutate(path + '?' + query, 'DELETE', undefined, '録画一覧から削除しました。');
            if (form.isConnected) dialog.close();
        } catch (error) { status.textContent = error.message; }
        finally { submit.disabled = false; }
    };
    details.replaceChildren(node('h2', row.title), form);
}
function recordingDetails(row, path) {
    const imported = row.importedVideo;
    const metadata = imported ? '登録動画 · ' + imported.name :
        date(row.start) + ' ' + time(row.start) + '–' + time(row.end) + '　' + channel(row.service);
    const actions = node('div', undefined, 'actions');
    const resume = resumePosition(row.id);
    if (row.ts || row.mp4) {
        actions.append(button(resume ? '続きから再生' : '再生', () => playRecording(row, path), 'primary'));
        if (resume) actions.append(button('最初から', () => playRecording(row, path, true)));
    }
    const favorite = button('', () => {
        const selected = !recordingPreferences[row.id]?.favorite;
        saveRecordingPreference(row.id, { favorite: selected });
        favorite.textContent = selected ? 'マイリストから外す' : 'マイリストに追加';
        groupLabel.hidden = !selected || !recordingGroups.length;
        renderReservations();
    });
    favorite.textContent = recordingPreferences[row.id]?.favorite ? 'マイリストから外す' : 'マイリストに追加';
    const groupLabel = node('label', 'グループ ', 'recording-group-assignment');
    const groupPicker = choose([['', '未分類'], ...recordingGroups.map(group => [group.id, group.name])], 'マイリストのグループ');
    groupPicker.value = assignedRecordingGroup(row.id);
    groupPicker.onchange = () => {
        saveRecordingPreference(row.id, { group: groupPicker.value });
        renderReservations();
    };
    groupLabel.hidden = !recordingPreferences[row.id]?.favorite || !recordingGroups.length;
    groupLabel.append(groupPicker);
    actions.append(favorite);
    if (row.ts) actions.append(link(/\.m2ts$/i.test(imported?.name ?? '') ? 'M2TSを保存' : 'TSを保存', './api/' + path + '/ts'));
    if (row.encoding) actions.append(node('span', row.automaticEditing ? '自動編集の準備中' : 'MP4変換中', 'status'));
    else if (!imported && row.ts && !row.mp4) actions.append(button('MP4に変換', async () => {
        await mutate(path + '/encode', 'POST', undefined, '変換を開始しました。');
        const updated = state.reservations.find(item => item.id === row.id);
        if (dialog.open && updated) recordingDetails(updated, path);
    }));
    if (!imported && (row.ts || row.mp4) && !row.encoding) actions.append(button('再変換', () => showReencode(row, path)));
    if (!row.encoding && (imported ? row.hasOriginalVideo : row.ts)) actions.append(button('CMカット・ロゴ消し', () => showCommercials(row, path)));
    if (state.canExtractLogo && (imported ? row.hasOriginalVideo : row.ts)) {
        actions.append(button('ロゴを抽出', () => showLogoExtraction(row, path)));
    }
    if ((row.ts || row.mp4) && !row.encoding) actions.append(button('ロゴ消し', () => showLogoRemoval(row, path)));
    if (row.hasEditedVideo) {
        const download = link('編集済みMP4を保存', './api/' + path + '/mp4');
        download.download = row.title + '（編集済み）.mp4';
        actions.append(download);
    }
    if (!row.encoding) actions.append(button('削除', () => confirmRecordingDeletion(row, path)));
    const status = imported ? (row.ts || row.mp4 ? 'ストレージから登録' : '元ファイルを参照できません') :
        statuses[row.status] + (row.rule ? ' · 自動予約' : '') + (row.relayOf ? ' · リレー' : '');
    const thumbnail = node('img', undefined, 'recording-detail-thumbnail');
    thumbnail.alt = '';
    thumbnail.onerror = () => thumbnail.remove();
    thumbnail.src = './api/' + path + '/thumbnail';
    details.replaceChildren(node('h2', row.title), node('p', metadata, 'meta'), thumbnail, node('p', status, 'status'));
    if (!imported || row.description) details.append(node('p', row.description || '番組説明はありません。', 'recording-description'));
    const savedLogoFormats = ['ts', 'mp4'].filter(format => row[format] && row.savedLogoFormats?.includes(format));
    if (savedLogoFormats.length) {
        details.append(node('p', (imported ? 'この動画' : 'この局') + 'のロゴ範囲は保存済みです（' +
            savedLogoFormats.map(format => format.toUpperCase()).join('・') + '）。対応する解像度はロゴ消し画面で確認できます。', 'meta'));
    }
    if (row.scheduleChanged) details.append(node('p', '放送時刻の変更を反映済み', 'meta'));
    if (row.partial) details.append(node('p', 'チューナーの空き待ちにより途中から録画', 'warning'));
    if (row.error || row.encodeError) details.append(node('p', row.error || row.encodeError, 'warning'));
    if (resume) {
        const progress = node('progress');
        progress.max = recordingPreferences[row.id].duration;
        progress.value = resume;
        progress.setAttribute('aria-label', '視聴進捗');
        details.append(progress);
    }
    details.append(actions, groupLabel);
    if (!dialog.open) dialog.showModal();
}
function showVideoImport() {
    const destination = choose(state.destinations.map(name => [name, name === 'default' ? '既定の保存先' : name]), '保存先');
    const locations = node('label', '保存先');
    locations.append(destination);
    const folderLabel = node('p', '', 'meta');
    const entries = node('div', undefined, 'list video-import-list');
    const status = node('p', '', 'meta');
    status.setAttribute('role', 'status');
    const form = node('form');
    const submit = node('button', 'まとめて登録', 'primary');
    const selection = node('p', '', 'meta');
    const titles = node('div', undefined, 'list video-import-list video-import-titles');
    const progress = node('p', '', 'meta');
    progress.setAttribute('role', 'status');
    const errors = node('ul', undefined, 'warning');
    const up = button('上のフォルダー', () => listFolder(folder.split('/').slice(0, -1).join('/')));
    form.append(selection, titles, submit, progress, errors);
    form.hidden = true;
    const selected = new Map();
    let folder = '', version = 0, registering = false;
    function updateSelection() {
        form.hidden = !selected.size;
        selection.textContent = selected.size + ' 件選択中 · 登録するタイトル';
    }
    async function listFolder(next) {
        const request = ++version;
        folder = next;
        up.hidden = !folder;
        folderLabel.textContent = '/' + folder;
        entries.replaceChildren();
        status.textContent = '動画を探しています。';
        try {
            const query = new URLSearchParams({ destination: destination.value, folder });
            const { folders, files } = await api('import-videos?' + query);
            if (request !== version || !entries.isConnected) return;
            status.textContent = folders.length || files.length ? '' : 'このフォルダーにMP4・TS・M2TSはありません。';
            const path = name => folder ? folder + '/' + name : name;
            entries.append(...folders.map(name => button('📁 ' + name, () => listFolder(path(name)))));
            for (const name of files) {
                const filePath = path(name);
                const target = destination.value;
                const key = JSON.stringify([target, filePath]);
                const check = node('input');
                check.type = 'checkbox';
                check.checked = selected.has(key);
                const label = node('label', undefined, 'video-import-file');
                label.append(check, node('span', name));
                check.onchange = () => {
                    if (check.checked) {
                        const title = node('input');
                        title.maxLength = 250;
                        title.value = name.replace(/\.(mp4|ts|m2ts)$/i, '').slice(0, 250);
                        const field = node('label');
                        field.append(node('span', target + ' / ' + filePath, 'meta'), title);
                        selected.set(key, { destination: target, name: filePath, title, field });
                        titles.append(field);
                    } else {
                        selected.get(key)?.field.remove();
                        selected.delete(key);
                    }
                    updateSelection();
                };
                entries.append(label);
            }
        } catch (error) { if (request === version) status.textContent = error.message; }
    }
    destination.onchange = () => listFolder('');
    form.onsubmit = async event => {
        event.preventDefault();
        if (!selected.size || registering) return;
        registering = true;
        picker.disabled = true;
        submit.disabled = true;
        for (const file of selected.values()) file.title.readOnly = true;
        errors.replaceChildren();
        const files = [...selected];
        let succeeded = 0;
        try {
            for (const [index, [key, file]] of files.entries()) {
                if (!form.isConnected) break;
                progress.textContent = (index + 1) + ' / ' + files.length + ' 件を登録しています。';
                try {
                    await api('import-videos', 'POST', { destination: file.destination, name: file.name, title: file.title.value });
                    file.field.remove();
                    selected.delete(key);
                    succeeded++;
                } catch (error) {
                    errors.append(node('li', file.name + ' · ' + error.message));
                }
            }
            if (succeeded) {
                message(succeeded + ' 件の動画を録画一覧に登録しました。');
                await load();
            }
            if (!form.isConnected) return;
            if (!selected.size) dialog.close();
            else {
                progress.textContent = succeeded + ' 件登録済み · ' + selected.size + ' 件を登録できませんでした。';
                updateSelection();
                await listFolder(folder);
            }
        } catch (error) { progress.textContent = error.message; }
        finally {
            registering = false;
            picker.disabled = false;
            submit.disabled = false;
            for (const file of selected.values()) file.title.readOnly = false;
        }
    };
    const picker = node('fieldset', undefined, 'video-import-picker');
    picker.append(locations, folderLabel, up, status, entries);
    details.replaceChildren(node('h2', '動画を登録'), picker, form);
    dialog.showModal();
    void listFolder('');
}
function editReservation(row, path) {
    const settings = recordingSettings(row.options);
    const form = node('form');
    const status = node('p', '', 'warning');
    status.setAttribute('role', 'status');
    const submit = node('button', '変更を保存', 'primary');
    form.append(settings.fields, submit, status);
    form.onsubmit = async event => {
        event.preventDefault();
        submit.disabled = true;
        try {
            await mutate(path, 'PATCH', { options: settings.read() }, '予約設定を更新しました。');
            dialog.close();
        } catch (error) { status.textContent = error.message; }
        finally { submit.disabled = false; }
    };
    details.replaceChildren(node('h2', '予約の編集'), node('p', row.title),
        node('p', date(row.start) + ' ' + time(row.start) + '–' + time(row.end) + '　' + channel(row.service), 'meta'), form);
    dialog.showModal();
}
function showBatchEdit() {
    const rows = state.reservations.filter(row => !row.encoding && ['completed', 'failed', 'cancelled'].includes(row.status) &&
        (row.importedVideo ? row.hasOriginalVideo : row.ts)).sort((a, b) => b.start - a.start);
    const form = node('form', undefined, 'batch-edit-form');
    const list = node('div', undefined, 'list batch-edit-list');
    const status = node('p', '', 'meta');
    status.setAttribute('role', 'status');
    const results = node('div', undefined, 'list batch-edit-results');
    const submit = node('button', '一括編集を開始', 'primary');
    const { label: profileLabel, profile } = editEncodeProfile();
    const checks = node('div', undefined, 'actions');
    const cut = node('input');
    const remove = node('input');
    cut.checked = true;
    for (const [check, text] of [[cut, 'CM候補を自動カット'], [remove, 'ロゴを消す']]) {
        check.type = 'checkbox';
        const label = node('label');
        label.append(check, text);
        checks.append(label);
    }
    const videos = rows.map(row => {
        const item = node('article', undefined, 'batch-edit-video');
        const check = node('input');
        check.type = 'checkbox';
        const label = node('label', undefined, 'video-import-file');
        label.append(check, node('span', row.title));
        const settings = node('details');
        settings.append(node('summary', 'ロゴ範囲を指定・確認' + (row.savedLogoFormats?.includes(row.importedVideo?.format ?? 'ts') ? '（保存済み）' : '')));
        settings.hidden = true;
        let logo;
        const update = () => { settings.hidden = !check.checked || !remove.checked; };
        check.onchange = update;
        settings.ontoggle = () => {
            if (!settings.open || logo) return;
            logo = logoEditFields(row, 'reservations/' + row.id, row.importedVideo?.format ?? 'ts', Boolean(row.importedVideo));
            settings.append(logo.fields);
        };
        item.append(label, settings);
        list.append(item);
        return { row, check, update, readLogo: () => logo?.read() };
    });
    remove.onchange = () => videos.forEach(video => video.update());
    form.append(checks, profileLabel, node('p', '検出したCM候補をそのまま適用します。ロゴ消し方式の指定がない場合は、局のAmatsukaze対応ロゴを優先します。', 'meta'),
        list, submit, status);
    if (!rows.length) {
        list.append(node('p', '一括編集できる動画はありません。', 'meta'));
        submit.disabled = true;
    }
    let timer;
    async function refreshBatch() {
        try {
            const batch = await api('batch-edit');
            if (!results.isConnected) return;
            form.hidden = Boolean(batch?.running);
            results.replaceChildren();
            for (const item of batch?.items ?? []) {
                const row = node('p', item.status + (Number.isFinite(item.progress) ? ' ' + item.progress + '%' : '') + ' · ' + item.title);
                if (item.error) row.append(node('span', ' — ' + item.error, 'warning'));
                results.append(row);
            }
            if (batch?.running) timer = setTimeout(refreshBatch, 1500);
        } catch (error) { if (results.isConnected) status.textContent = error.message; }
    }
    form.onsubmit = async event => {
        event.preventDefault();
        submit.disabled = true;
        status.textContent = '';
        try {
            const entries = videos.filter(video => video.check.checked).map(video => ({
                id: video.row.id, logo: remove.checked ? video.readLogo() : undefined
            }));
            if (!entries.length || (!cut.checked && !remove.checked)) throw new Error('動画と編集内容を選んでください。');
            if (!confirm(entries.length + ' 件の動画を一括編集しますか？ 編集済みMP4がある場合は、変換成功後に差し替えます。')) return;
            await api('batch-edit', 'POST', { entries, cutCommercials: cut.checked, removeLogo: remove.checked, encodeProfile: profile.value });
            for (const video of videos) {
                video.check.checked = false;
                video.update();
            }
            clearTimeout(timer);
            await refreshBatch();
        } catch (error) { status.textContent = error.message; }
        finally { submit.disabled = !rows.length; }
    };
    dialog.addEventListener('close', () => clearTimeout(timer), { once: true });
    details.replaceChildren(node('h2', 'CMカット・ロゴ消しを一括編集'), form, results);
    dialog.showModal();
    void refreshBatch();
}
function renderReservations() {
    const waiting = view === 'reservations';
    const term = recordingFilter.trim().normalize('NFKC').toLowerCase();
    const rows = state.reservations.filter(r => {
        const pending = ['scheduled', 'recording'].includes(r.status);
        const hasRecording = r.ts || r.mp4;
        if (waiting) return !r.importedVideo && (pending || !hasRecording);
        if (pending || (!hasRecording && !r.importedVideo)) return false;
        const text = [r.title, r.description, channel(r.service)].join(' ').normalize('NFKC').toLowerCase();
        return text.includes(term) && (recordingTab === 'all' ||
            (recordingTab === 'favorites' ? recordingPreferences[r.id]?.favorite &&
                (!recordingGroup || (assignedRecordingGroup(r.id) || 'ungrouped') === recordingGroup) : resumePosition(r.id)));
    });
    rows.sort((a, b) => waiting ? a.start - b.start : b.start - a.start);
    const list = node('div', undefined, waiting ? 'list' : 'recording-grid');
    if (!rows.length) list.append(node('p', waiting ? '予約はありません。' : '該当する録画はありません。', 'empty'));
    for (const r of rows) {
        const row = node('article', undefined, waiting ? 'row' : 'row recording-card');
        const path = 'reservations/' + r.id;
        if (!waiting) {
            const image = node('img');
            image.alt = '';
            image.loading = 'lazy';
            const cover = button(undefined, () => recordingDetails(r, path), 'recording-cover');
            cover.setAttribute('aria-label', r.title + 'の詳細を開く');
            const fallback = node('span', '▶', 'recording-cover-fallback');
            fallback.setAttribute('aria-hidden', 'true');
            image.onerror = () => image.remove();
            image.src = './api/' + path + '/thumbnail';
            cover.append(fallback, image);
            row.append(cover, node('strong', r.title, 'recording-title'),
                node('p', date(r.start) + ' ' + time(r.start) + (r.importedVideo ? ' · 登録動画' : '–' + time(r.end)), 'meta'));
            list.append(row);
            continue;
        }
        const summary = node('div');
        summary.append(node('div', statuses[r.status] + (r.rule ? ' · 自動予約' : '') + (r.relayOf ? ' · リレー' : ''), 'status'), node('strong', r.title),
            node('p', date(r.start) + ' ' + time(r.start) + '–' + time(r.end) + '　' + channel(r.service), 'meta'));
        if (r.conflict || (waiting && r.waitedForTuner && r.status === 'scheduled')) summary.append(node('p', 'チューナー競合の見込み・空き待ち', 'warning'));
        if (r.scheduleChanged) summary.append(node('p', '放送時刻の変更を反映済み', 'meta'));
        if (r.partial) summary.append(node('p', 'チューナーの空き待ちにより途中から録画', 'warning'));
        if (r.error || r.encodeError) summary.append(node('p', r.error || r.encodeError, 'meta'));
        const actions = node('div', undefined, 'actions');
        if (r.status === 'scheduled' && r.start > Date.now()) actions.append(button('編集', () => editReservation(r, path)));
        if (['scheduled', 'recording'].includes(r.status)) actions.append(button(r.status === 'recording' ? '録画停止' : '予約取消', () =>
            mutate(path + '/cancel', 'POST', undefined, '予約を取り消しました。')));
        else actions.append(button('削除', () => {
            if (confirm('この録画履歴を削除しますか？')) return mutate(path, 'DELETE', undefined, '削除しました。');
        }));
        row.append(summary, actions);
        list.append(row);
    }
    if (!waiting) {
        let toolbar = content.querySelector('.recording-tools');
        if (!toolbar) {
            toolbar = node('div', undefined, 'toolbar recording-tools');
            const search = node('input');
            search.type = 'search';
            search.placeholder = '録画番組を検索';
            search.setAttribute('aria-label', search.placeholder);
            search.value = recordingFilter;
            search.oninput = () => {
                recordingFilter = search.value;
                renderReservations();
            };
            toolbar.append(search, button('動画を登録', showVideoImport), button('CMカット・ロゴ消しを一括編集', showBatchEdit));
            for (const [id, title] of [['all', 'すべて'], ['resume', '視聴途中'], ['favorites', 'マイリスト']]) {
                const tab = button(title, () => { recordingTab = id; renderReservations(); });
                tab.dataset.recordingTab = id;
                toolbar.append(tab);
            }
        }
        for (const tab of toolbar.querySelectorAll('[data-recording-tab]')) tab.setAttribute('aria-pressed', String(tab.dataset.recordingTab === recordingTab));
        if (toolbar.isConnected) toolbar.nextElementSibling.replaceWith(list);
        else content.replaceChildren(toolbar, list);
        toolbar.querySelector('.recording-group-tools')?.remove();
        if (recordingTab === 'favorites') {
            const groups = node('div', undefined, 'actions recording-group-tools');
            const picker = choose([['', 'すべてのグループ'], ['ungrouped', '未分類'],
                ...recordingGroups.map(group => [group.id, group.name])], 'グループで絞り込む');
            picker.value = recordingGroup;
            picker.onchange = () => {
                recordingGroup = picker.value;
                renderReservations();
                toolbar.querySelector('.recording-group-tools select')?.focus();
            };
            groups.append(picker, button('グループ管理', showRecordingGroups));
            toolbar.append(groups);
        }
        return;
    }
    content.replaceChildren();
    if (waiting) content.append(node('p', state.tunerCount === null ? 'チューナー情報を取得できないため、競合は判定できません。' :
        '利用可能チューナー ' + state.tunerCount + ' 台', 'meta tuner-summary'));
    content.append(list);
}
function ruleForm(rule, onSave, onPreview) {
    const form = node('form', undefined, 'rule-form');
    const fields = node('div', undefined, 'rule-fields');
    const add = (name, input) => {
        const label = node('label', name);
        label.append(input);
        fields.append(label);
        return input;
    };
    const field = (label, value, type = 'text') => {
        const input = node('input');
        input.type = type;
        input.value = value ?? '';
        if (type === 'text') input.maxLength = 120;
        return add(label, input);
    };
    const select = (label, options, value) => {
        const input = choose(options, label);
        input.value = value ?? '';
        return add(label, input);
    };
    const keyword = field('含むキーワード', rule?.keyword);
    keyword.maxLength = 512;
    const keywordMatch = select('キーワードの照合', [
        ['text', '番組名・説明に含む'], ['title', '番組名に含む'], ['titleExact', '番組名と完全一致']
    ], rule?.keywordMatch ?? 'text');
    const splitKeywords = select('複数キーワード', [['false', '入力した語句のまま'], ['true', '空白で区切って照合']],
        String(rule?.splitKeywords ?? false));
    const exclude = field('除外キーワード', rule?.exclude);
    const skipDuplicateEpisodes = select('同じ放送回の予約', [
        ['false', 'すべて予約する'], ['true', '番組名・回番号・説明が一致する放送を除く']
    ], String(rule?.skipDuplicateEpisodes ?? false));
    const waveTypes = new Set(visibleServices.map(s => s.channel?.type).filter(Boolean));
    if (rule?.wave) waveTypes.add(rule.wave);
    const wave = select('放送波', [['', 'すべて'], ...[...waveTypes].map(type => [type, type === 'GR' ? '地上波' : type])], rule?.wave);
    const selectedStations = new Set(ruleServices(rule ?? {}));
    const stationPicker = node('details', undefined, 'rule-station-picker');
    const stationSummary = node('summary');
    const stationList = node('div', undefined, 'rule-station-list');
    const stations = new Map(visibleServices.map(s => [s.id, s]));
    for (const id of selectedStations) {
        if (!stations.has(id)) stations.set(id, { id, name: channel(id) });
    }
    const updateStationSummary = () => {
        stationSummary.textContent = selectedStations.size ? '放送局 · ' + selectedStations.size + ' 局選択中' : '放送局 · すべて';
    };
    const showStations = () => {
        stationList.replaceChildren();
        for (const station of stations.values()) {
            if (wave.value && station.channel?.type !== wave.value && !selectedStations.has(station.id)) continue;
            const check = node('input');
            check.type = 'checkbox';
            check.checked = selectedStations.has(station.id);
            check.onchange = () => {
                if (check.checked) selectedStations.add(station.id);
                else selectedStations.delete(station.id);
                updateStationSummary();
            };
            const label = node('label');
            label.append(check, node('span', station.name));
            stationList.append(label);
        }
    };
    wave.addEventListener('change', showStations);
    showStations();
    updateStationSummary();
    stationPicker.append(stationSummary, stationList, button('選択を解除', () => {
        selectedStations.clear();
        showStations();
        updateStationSummary();
    }));
    const genre = select('ジャンル', [['', 'すべて'], ...genres.map((name, i) => [i, name]), [15, 'その他']], rule?.genre);
    const subgenre = select('サブジャンル', [], rule?.subgenre);
    bindSubgenre(genre, subgenre, rule?.subgenre);
    const start = field('開始時刻 (JST)', rule?.from, 'time');
    const end = field('終了時刻 (JST)', rule?.to, 'time');
    const dateFrom = field('放送日（開始）', rule?.dateFrom, 'date');
    const dateTo = field('放送日（終了）', rule?.dateTo, 'date');
    const dayGroup = node('fieldset', undefined, 'rule-days');
    dayGroup.append(node('legend', '曜日（未選択は全曜日）'));
    for (const day of weekdays) {
        const check = node('input');
        check.type = 'checkbox';
        check.value = day;
        check.checked = rule?.days?.includes(day) ?? false;
        const label = node('label');
        label.append(check, day);
        dayGroup.append(label);
    }
    const submit = node('button', rule?.id ? '変更を保存' : 'ルール追加', 'primary');
    const feedback = node('p', '', 'warning');
    feedback.setAttribute('role', 'status');
    const settings = recordingSettings(rule?.options);
    const read = () => ({ keyword: keyword.value.trim(), keywordMatch: keywordMatch.value,
                options: settings.read(),
                skipDuplicateEpisodes: skipDuplicateEpisodes.value === 'true',
                splitKeywords: splitKeywords.value === 'true', exclude: exclude.value.trim(), wave: wave.value,
                services: [...selectedStations],
                genre: genre.value === '' ? null : Number(genre.value), from: start.value, to: end.value,
                subgenre: subgenre.value === '' ? null : Number(subgenre.value),
                dateFrom: dateFrom.value, dateTo: dateTo.value,
                days: [...dayGroup.querySelectorAll('input:checked')].map(input => input.value) });
    const actions = node('div', undefined, 'actions');
    actions.append(submit);
    if (onPreview) actions.append(button('対象番組を検索', () => onPreview(read())));
    form.append(fields, stationPicker, dayGroup, settings.fields, actions, feedback);
    form.onsubmit = async event => {
        event.preventDefault();
        submit.disabled = true;
        feedback.textContent = '';
        try {
            await onSave(read());
        } catch (error) { feedback.textContent = error.message; }
        finally { submit.disabled = false; }
    };
    return form;
}
let searchCriteria = null;
let searchPage = 0;
let rulePreview = null;
function renderSearch() {
    const form = node('form', undefined, 'rule-form');
    const fields = node('div', undefined, 'rule-fields');
    function field(key, label, input) {
        const wrapper = node('label', label);
        input.name = key;
        input.value = searchCriteria?.[key] ?? '';
        wrapper.append(input);
        fields.append(wrapper);
        return input;
    }
    for (const [key, label] of [['include', '含むキーワード'], ['exclude', '除外キーワード']]) {
        const input = node('input');
        input.type = 'search';
        input.maxLength = 120;
        field(key, label, input);
    }
    const waves = [...new Set(visibleServices.map(s => s.channel?.type).filter(Boolean))];
    const wave = field('wave', '放送波', choose([['', 'すべて'], ...waves.map(w => [w, w === 'GR' ? '地上波' : w])], '放送波'));
    const station = field('station', '放送局', choose([], '放送局'));
    function updateStations(selected = '') {
        const options = choose([['', 'すべて'], ...visibleServices.filter(s => !wave.value || s.channel?.type === wave.value)
            .map(s => [s.id, s.name])], '放送局');
        station.replaceChildren(...options.children);
        station.value = [...station.options].some(option => option.value === selected) ? selected : '';
    }
    updateStations(searchCriteria?.station);
    wave.onchange = () => updateStations(station.value);
    const genre = field('genre', 'ジャンル', choose([['', 'すべて'], ...genres.map((name, i) => [i, name]), [15, 'その他']], 'ジャンル'));
    const subgenre = field('subgenre', 'サブジャンル', choose([], 'サブジャンル'));
    bindSubgenre(genre, subgenre, searchCriteria?.subgenre);
    for (const [key, label] of [['start', '放送日（開始）'], ['end', '放送日（終了）']]) {
        const input = node('input');
        input.type = 'date';
        field(key, label, input);
    }
    const actions = node('div', undefined, 'actions search-actions');
    actions.append(node('button', '検索', 'primary'), button('この検索条件で自動予約', () => {
        const input = Object.fromEntries(new FormData(form));
        const previewMatchesForm = rulePreview && Object.keys(input).every(key => input[key] === searchCriteria[key]);
        const preset = previewMatchesForm ? rulePreview : searchRule(input);
        details.replaceChildren(node('h2', '検索条件から自動予約を作成'), ruleForm(preset, async data => {
            await mutate('rules', 'POST', data, '自動予約ルールを追加しました。');
            dialog.close();
        }));
        dialog.showModal();
    }), button('条件をクリア', () => {
        searchCriteria = null;
        rulePreview = null;
        searchPage = 0;
        renderSearch();
        content.querySelector('input')?.focus();
    }));
    const summary = node('p', '', 'meta');
    summary.setAttribute('role', 'status');
    const results = node('div', undefined, 'list');
    const pages = node('div', undefined, 'actions search-actions');
    form.append(fields, actions);
    content.replaceChildren(form, summary, results, pages);
    function showResults() {
        results.replaceChildren();
        pages.replaceChildren();
        if (!searchCriteria) {
            summary.textContent = '取得済みの番組情報を検索できます。';
            return;
        }
        const criteria = rulePreview ?? searchRule(searchCriteria);
        if (criteria.dateFrom && criteria.dateTo && criteria.dateFrom > criteria.dateTo) {
            summary.textContent = '終了日は開始日以降を指定してください。';
            return;
        }
        const allowed = new Map(visibleServices.map(s => [s.id, s.channel?.type]));
        const now = Date.now();
        const matches = guide.programs.filter(p => allowed.has(p.service) && (rulePreview ? p.start >= now : p.end > now) &&
            matchesRule(criteria, p, allowed.get(p.service))).sort((a, b) => a.start - b.start);
        const pageSize = 30;
        const pageCount = Math.ceil(matches.length / pageSize);
        searchPage = Math.min(searchPage, Math.max(0, pageCount - 1));
        const stations = rulePreview && ruleServices(rulePreview);
        summary.textContent = (rulePreview ? '自動予約の対象候補 · ' +
            (stations.length > 1 ? stations.map(channel).join('、') + ' · ' : '') : '') +
            (matches.length ? matches.length + ' 件 · ' + (searchPage + 1) + ' / ' + pageCount + ' ページ' : '条件に一致する番組がありません。');
        const reservations = new Map(state.reservations.filter(r => ['scheduled', 'recording', 'completed'].includes(r.status))
            .map(r => [r.programId, r]));
        for (const p of matches.slice(searchPage * pageSize, (searchPage + 1) * pageSize)) {
            const row = node('article', undefined, 'row');
            const info = node('div');
            info.append(node('p', date(p.start) + ' ' + time(p.start) + '–' + time(p.end) + '　' + channel(p.service), 'meta'),
                node('strong', p.title));
            if (p.description) info.append(node('p', p.description, 'meta search-description'));
            const reservation = reservations.get(p.id);
            if (reservation) info.append(node('p', reservation.conflict ? 'チューナー競合の見込み' : statuses[reservation.status], 'status'));
            row.append(info, button(reservation ? '番組詳細' : '詳細・録画予約', () => programDetails(p)));
            results.append(row);
        }
        for (const [label, step] of [['前のページ', -1], ['次のページ', 1]]) {
            if (pageCount < 2) break;
            const control = button(label, () => {
                searchPage += step;
                showResults();
                summary.scrollIntoView({ block: 'nearest' });
                pages.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
            });
            control.disabled = searchPage + step < 0 || searchPage + step >= pageCount;
            pages.append(control);
        }
    }
    form.onsubmit = event => {
        event.preventDefault();
        rulePreview = null;
        searchCriteria = Object.fromEntries(new FormData(form));
        searchPage = 0;
        showResults();
    };
    showResults();
}
function searchRule(criteria) {
    return { keyword: criteria.include.trim(), exclude: criteria.exclude.trim(), keywordMatch: 'text', splitKeywords: true,
        wave: criteria.wave, service: criteria.station ? Number(criteria.station) : null,
        genre: criteria.genre ? Number(criteria.genre) : null, subgenre: criteria.subgenre ? Number(criteria.subgenre) : null,
        dateFrom: criteria.start, dateTo: criteria.end };
}
function previewRule(rule) {
    rulePreview = rule;
    const stations = ruleServices(rule);
    searchCriteria = { include: rule.keyword || '', exclude: rule.exclude || '', wave: rule.wave || '',
        station: stations.length === 1 ? String(stations[0]) : '', genre: String(rule.genre ?? ''), subgenre: String(rule.subgenre ?? ''),
        start: rule.dateFrom || '', end: rule.dateTo || '' };
    searchPage = 0;
    if (dialog.open) dialog.close();
    location.hash = 'search';
}
function renderRules() {
    const form = ruleForm(null, data => mutate('rules', 'POST', data, 'ルールを追加しました。'), previewRule);
    const list = node('div', undefined, 'list');
    if (!state.rules.length) list.append(node('p', '自動予約ルールはありません。', 'empty'));
    for (const rule of state.rules) {
        const row = node('article', undefined, 'row');
        const actions = node('div', undefined, 'actions');
        const path = 'rules/' + rule.id;
        actions.append(button('編集', () => {
            details.replaceChildren(node('h2', '自動予約ルールを編集'), ruleForm(rule, async data => {
                await mutate(path, 'PATCH', data, 'ルールを更新しました。');
                dialog.close();
            }, previewRule));
            dialog.showModal();
        }), button(rule.enabled ? '無効にする' : '有効にする', () => mutate(path, 'PATCH', { enabled: !rule.enabled }, 'ルールを更新しました。')),
            button('削除', () => mutate(path, 'DELETE', undefined, 'ルールを削除しました。')));
        const matchLabel = rule.keywordMatch === 'titleExact' ? '番組名と完全一致' :
            rule.keywordMatch === 'title' ? '番組名に含む' : '番組名・説明に含む';
        const conditions = [rule.keyword && matchLabel + ' ' + rule.keyword, rule.exclude && '除外 ' + rule.exclude,
            rule.wave, ruleServices(rule).map(channel).join('、'),
            rule.genre != null && (genres[rule.genre] || 'その他'), rule.days?.join('・'),
            rule.subgenre != null && subgenreName(rule.genre, rule.subgenre),
            (rule.dateFrom || rule.dateTo) && (rule.dateFrom || '') + '〜' + (rule.dateTo || ''),
            rule.from && rule.from + '〜' + rule.to,
            rule.skipDuplicateEpisodes && '同じ放送回を除く'].filter(Boolean);
        const summary = node('div');
        summary.append(node('strong', conditions.join(' / ')), node('p', rule.enabled ? '有効' : '無効', 'meta'));
        row.append(summary, actions);
        list.append(row);
    }
    content.replaceChildren(form, list);
}
function logoDataSettings() {
    const section = node('details', undefined, 'settings-logo-data');
    const status = node('p', '', 'meta');
    status.setAttribute('role', 'status');
    const controls = node('div', undefined, 'actions');
    const picker = choose([], 'ロゴデータ');
    const image = node('canvas', undefined, 'logo-data-image');
    image.setAttribute('role', 'img');
    image.hidden = true;
    controls.hidden = true;
    controls.append(picker);
    section.append(node('summary', 'ロゴ消し用のロゴ画像'), controls, status, image);
    let request = 0;
    async function preview() {
        const current = ++request;
        image.hidden = true;
        status.textContent = 'ロゴ画像を読み込んでいます。';
        try {
            const { x, y, width, height, count, rgba } = await api('logo-data/' + picker.value);
            if (current !== request) return;
            drawLogoData(image, { width, height, rgba });
            image.setAttribute('aria-label', picker.selectedOptions[0].text + 'のロゴ画像');
            status.textContent = width + ' × ' + height + ' px · 位置 (' + x + ', ' + y + ')' +
                (count > 1 ? ' · 先頭のロゴを表示（全 ' + count + ' 件）' : '');
            image.hidden = false;
        } catch (error) {
            if (current === request) status.textContent = error.message;
        }
    }
    picker.onchange = preview;
    section.ontoggle = async () => {
        const current = ++request;
        if (!section.open) return;
        image.hidden = true;
        controls.hidden = true;
        status.textContent = '登録済みのロゴを確認しています。';
        try {
            const { configured, logos } = await api('logo-data');
            if (current !== request) return;
            if (!logos.length) {
                status.textContent = configured ? '登録済みのロゴ画像はありません。' : 'ロゴデータの保存先が設定されていません。';
                return;
            }
            const previous = picker.value;
            picker.replaceChildren(...choose(logos.map(logo => [
                logo.service + '.' + logo.format, logo.name + '（' + logo.format.toUpperCase() + '）'
            ]), '').options);
            if ([...picker.options].some(option => option.value === previous)) picker.value = previous;
            controls.hidden = false;
            await preview();
        } catch (error) {
            if (current === request) status.textContent = error.message;
        }
    };
    return section;
}
function renderSettings({ config, stations, canApplySettings }) {
    const appearanceForm = node('form', undefined, 'rule-form');
    const theme = choose([['light', 'ライト'], ['dark', 'ダーク']], 'テーマ');
    theme.value = appearance.theme;
    const accent = node('input');
    accent.type = 'color';
    accent.value = appearance.accent;
    const themeLabel = node('label', 'テーマ');
    const accentLabel = node('label', 'アクセントカラー');
    themeLabel.append(theme);
    accentLabel.append(accent);
    const subtitleColor = node('input');
    subtitleColor.type = 'color';
    subtitleColor.value = appearance.subtitleColor;
    const subtitleLabel = node('label', '字幕の文字色');
    subtitleLabel.append(subtitleColor);
    const appearanceFields = node('div', undefined, 'rule-fields appearance-fields');
    appearanceFields.append(themeLabel, accentLabel, subtitleLabel);
    const appearanceStatus = node('p', 'このブラウザーに保存されます。', 'meta');
    appearanceStatus.setAttribute('role', 'status');
    function saveAppearance() {
        appearance = { theme: theme.value, accent: accent.value, subtitleColor: subtitleColor.value };
        applyAppearance();
        try {
            localStorage.setItem(appearanceKey, JSON.stringify(appearance));
            appearanceStatus.textContent = '画面の配色を保存しました。';
        } catch { appearanceStatus.textContent = '配色を反映しました。このブラウザーでは保存できません。'; }
    }
    theme.onchange = saveAppearance;
    accent.oninput = saveAppearance;
    subtitleColor.oninput = saveAppearance;
    appearanceForm.onsubmit = event => event.preventDefault();
    appearanceForm.append(node('h2', '画面の配色'), appearanceFields, appearanceStatus);
    const form = node('form', undefined, 'rule-form');
    const fields = node('div', undefined, 'rule-fields');
    const inputs = {};
    for (const [key, label, fallback] of [['tunerUrl', 'チューナーURL', ''], ['port', '待受ポート', 8780],
        ['dataDirectory', '既定の保存先', ''], ['ffmpeg', 'FFmpeg実行ファイル', 'ffmpeg'], ['nvencc', 'NVEncC実行ファイル', ''],
        ['qsvenc', 'QSVEncC実行ファイル', ''], ['vceenc', 'VCEEncC実行ファイル', ''],
        ['epgInterval', 'EPG更新間隔（秒）', 15], ['liveLimit', '同時ライブ視聴数', 4],
        ['recordedFormat', '既定のファイル名書式', '']]) {
        const wrapper = node('label', label);
        const input = node('input');
        input.type = typeof fallback === 'number' ? 'number' : 'text';
        if (input.type === 'number') input.required = true;
        input.value = config[key] ?? fallback;
        if (key === 'recordedFormat') {
            input.maxLength = 240;
            input.placeholder = '%YEAR%-%MONTH%-%DAY%_%TITLE%';
        }
        inputs[key] = input;
        wrapper.append(input);
        fields.append(wrapper);
    }
    const locations = node('fieldset', undefined, 'rule-days');
    locations.append(node('legend', '追加の録画保存先'));
    const entries = node('div', undefined, 'list');
    function addLocation(name = '', path = '') {
        const row = node('div', undefined, 'actions');
        const label = node('input');
        const directory = node('input');
        label.placeholder = '保存先の名前';
        directory.placeholder = 'フォルダーのパス';
        label.setAttribute('aria-label', label.placeholder);
        directory.setAttribute('aria-label', directory.placeholder);
        label.value = name;
        directory.value = path;
        row.append(label, directory, button('行を削除', () => row.remove()));
        entries.append(row);
    }
    for (const [name, path] of Object.entries(config.recordingDirectories || {})) addLocation(name, path);
    locations.append(entries, button('保存先を追加', () => addLocation()));
    const hidden = new Set(config.guideHiddenChannels || []);
    const channels = node('details', undefined, 'settings-channels');
    channels.append(node('summary', '非表示にする放送局'));
    const list = node('div', undefined, 'rule-fields');
    for (const station of stations) {
        const label = node('label', station.name);
        const input = node('input');
        input.type = 'checkbox';
        input.checked = hidden.has(station.id);
        input.onchange = () => input.checked ? hidden.add(station.id) : hidden.delete(station.id);
        label.prepend(input);
        list.append(label);
    }
    channels.append(list);
    const submit = node('button', '設定を保存', 'primary');
    const profileLabel = node('label', 'エンコードプロファイル（JSON）');
    const profileInput = node('textarea');
    profileInput.rows = 7;
    profileInput.value = JSON.stringify(config.encodeProfiles ?? [], null, 2);
    profileLabel.append(profileInput);
    const defaultLabel = node('label', '録画変換の既定プロファイル');
    const defaultProfile = choose([], '録画変換の既定プロファイル');
    defaultLabel.append(defaultProfile);
    function updateDefaultProfiles(selected) {
        let list;
        try { list = JSON.parse(profileInput.value || '[]'); }
        catch { return; }
        if (!Array.isArray(list)) return;
        const names = new Set(list.map(profile => profile?.name).filter(name => typeof name === 'string' && name));
        if (selected) names.add(selected);
        defaultProfile.replaceChildren(...choose([['', '自動（NVEncC / FFmpeg）'],
            ...[...names].map(name => [name, name])], '').options);
        defaultProfile.value = selected;
    }
    updateDefaultProfiles(config.defaultEncodeProfile || '');
    profileInput.addEventListener('input', () => updateDefaultProfiles(defaultProfile.value));
    const liveSettings = node('fieldset', undefined, 'live-profile-settings');
    const liveRows = node('div', undefined, 'live-profile-list');
    const liveDefaultLabel = node('label', 'ライブ視聴の既定プロファイル');
    const liveDefault = choose([], 'ライブ視聴の既定プロファイル');
    liveDefaultLabel.append(liveDefault);
    const liveProfiles = new Map();
    function updateLiveDefault(selected = liveDefault.value) {
        const names = new Set([...liveProfiles.values()].map(fields => fields.name.value.trim()).filter(Boolean));
        liveDefault.replaceChildren(...choose([['', '自動（NVEncC / FFmpeg）'],
            ...[...names].map(name => [name, name])], '').options);
        liveDefault.value = names.has(selected) ? selected : '';
    }
    function addLiveProfile(profile = {}) {
        const row = node('details', undefined, 'live-profile');
        row.name = 'live-profile-edit';
        const summary = node('summary');
        const title = node('strong');
        const description = node('span', undefined, 'meta');
        summary.append(title, description);
        const fields = node('div', undefined, 'rule-fields live-profile-fields');
        row.append(summary, fields);
        const name = node('input');
        name.required = true;
        name.maxLength = 80;
        name.value = profile.name ?? '';
        const encoder = choose([['ffmpeg', 'FFmpeg'], ['nvencc', 'NVEncC'], ['qsvenc', 'QSVEncC'],
            ['vceenc', 'VCEEncC']], 'エンコーダー');
        encoder.value = profile.encoder ?? 'ffmpeg';
        const height = choose([360, 480, 720, 1080].map(value => [String(value), value + 'p']), '解像度');
        height.value = String(profile.height ?? 720);
        const bitrate = node('input');
        bitrate.type = 'number';
        bitrate.min = '300';
        bitrate.max = '20000';
        bitrate.required = true;
        bitrate.value = profile.bitrate ?? 2200;
        const rowFields = { name, encoder, height, bitrate };
        for (const [control, caption] of [[name, '名前'], [encoder, 'エンコーダー'], [height, '解像度'],
            [bitrate, '映像ビットレート（kbps）']]) {
            const label = node('label', caption);
            label.append(control);
            fields.append(label);
        }
        function updateSummary() {
            title.textContent = name.value.trim() || '新しいプロファイル';
            description.textContent = [encoder.selectedOptions[0].text, height.selectedOptions[0].text,
                bitrate.value && bitrate.value + ' kbps'].filter(Boolean).join(' · ');
        }
        fields.addEventListener('input', updateSummary);
        row.addEventListener('invalid', () => { row.open = true; }, true);
        updateSummary();
        let previousName = name.value;
        name.onchange = () => {
            updateLiveDefault(liveDefault.value === previousName && previousName ? name.value.trim() : liveDefault.value);
            previousName = name.value.trim();
        };
        fields.append(button('削除', () => {
            liveProfiles.delete(row);
            row.remove();
            updateLiveDefault();
        }));
        liveProfiles.set(row, rowFields);
        liveRows.append(row);
        return row;
    }
    for (const profile of config.liveProfiles ?? []) addLiveProfile(profile);
    updateLiveDefault(config.defaultLiveProfile || '');
    const liveActions = node('div', undefined, 'live-profile-actions');
    liveActions.append(liveDefaultLabel, button('プロファイルを追加', () => {
        const row = addLiveProfile();
        row.open = true;
        row.querySelector('input').focus();
    }));
    liveSettings.append(node('legend', 'ライブ用エンコードプロファイル'), liveActions, liveRows);
    const status = node('p', '変更はサーバーの再起動後に反映されます。', 'meta');
    status.setAttribute('role', 'status');
    const actions = node('div', undefined, 'actions');
    actions.append(submit);
    const apply = button('設定を反映', async () => {
        submit.disabled = true;
        try {
            const restart = await api('settings/apply', 'POST', {});
            status.textContent = 'サーバーを再起動しています。';
            const target = new URL(location.href);
            if (target.protocol === 'http:' && target.pathname === '/') target.port = restart.port;
            target.hash = 'settings';
            if (target.origin !== location.origin) {
                status.replaceChildren('待受ポートを変更しました。再起動後に ', link('新しい設定画面', target.href), ' を開いてください。');
                return;
            }
            for (let attempt = 0; attempt < 30; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const response = await fetch('./api/settings', { cache: 'no-store', signal: AbortSignal.timeout(2000) })
                    .then(r => r.ok ? r.json() : null).catch(() => null);
                if (response?.instance && response.instance !== restart.instance) {
                    status.textContent = '設定を反映しました。';
                    return;
                }
            }
            status.textContent = 'サーバーの再起動を確認できませんでした。サービスの状態を確認してください。';
        } catch (error) { status.textContent = error.message; }
        finally { submit.disabled = false; }
    });
    if (canApplySettings) actions.append(apply);
    form.append(fields, node('p', 'ファイル名の変数: %TITLE%、%CHNAME%、%YEAR%、%MONTH%、%DAY%、%HOUR%、%MIN%、%SEC%、%DOW%、%HALF_WIDTH_TITLE%、%HALF_WIDTH_CHNAME%、%ID%', 'meta'),
        locations, profileLabel, defaultLabel, liveSettings, channels, actions, status);
    form.onsubmit = async event => {
        event.preventDefault();
        submit.disabled = true;
        apply.disabled = true;
        try {
            const pairs = [...entries.children].map(row => [...row.querySelectorAll('input')].map(input => input.value.trim()))
                .filter(pair => pair.some(Boolean));
            if (new Set(pairs.map(([name]) => name)).size !== pairs.length) throw new Error('保存先の名前が重複しています。');
            const next = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim() || null]));
            for (const key of ['port', 'epgInterval', 'liveLimit']) next[key] = Number(next[key]);
            next.recordingDirectories = Object.fromEntries(pairs);
            next.encodeProfiles = JSON.parse(profileInput.value || '[]');
            next.defaultEncodeProfile = defaultProfile.value;
            next.liveProfiles = [...liveProfiles.values()].map(({ name, encoder, height, bitrate }) => ({
                name: name.value.trim(), encoder: encoder.value, height: Number(height.value), bitrate: Number(bitrate.value)
            }));
            next.defaultLiveProfile = liveDefault.value;
            next.guideHiddenChannels = [...hidden].sort((a, b) => a - b);
            await api('settings', 'PUT', next);
            status.textContent = canApplySettings ? '設定を保存しました。「設定を反映」で再起動します。' :
                '設定を保存しました。反映するにはサーバーを再起動してください。';
        } catch (error) { status.textContent = error.message; }
        finally { submit.disabled = false; apply.disabled = false; }
    };
    const about = node('section', undefined, 'rule-form settings-about');
    const aboutHeading = node('h2', undefined, 'settings-about-heading');
    const aboutIcon = node('img', undefined, 'brand-icon');
    aboutIcon.src = './icon-192.png?v=uzume';
    aboutIcon.alt = '';
    aboutIcon.width = 48;
    aboutIcon.height = 48;
    aboutHeading.append(aboutIcon, node('span', 'UZUME TV／宇受売 TVの名前の由来'));
    about.append(
        aboutHeading,
        node('p', '「UZUME」は、日本神話の天岩戸の場面で舞を披露した神、アメノウズメに由来します。'),
        node('p', '「番組を楽しむ場所」というイメージを込め、短く親しみやすく、ロゴにもまとめやすい名前にしました。')
    );
    content.replaceChildren(appearanceForm, form, logoDataSettings(), about);
}
function renderStorage(entries) {
    const format = bytes => {
        const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        let unit = 0;
        while (bytes >= 1000 && unit < units.length - 1) {
            bytes /= 1000;
            unit++;
        }
        return (unit ? bytes.toFixed(1) : bytes) + ' ' + units[unit];
    };
    const list = node('div', undefined, 'storage-list');
    list.append(button('容量を更新', refreshView), node('p', '保存先のあるディスク全体の容量を表示します。', 'meta'));
    for (const entry of entries) {
        const name = entry.name === 'default' ? '既定の保存先' : entry.name;
        const section = node('section', undefined, 'storage-entry');
        section.append(node('h2', entry.unavailable ? name : name + ' · ' + format(entry.total)));
        if (entry.unavailable) section.append(node('p', '容量を取得できませんでした。', 'meta'));
        else {
            const bar = node('progress');
            bar.max = entry.total;
            bar.value = entry.used;
            bar.setAttribute('aria-label', name + 'の使用容量');
            const counts = node('div', undefined, 'storage-counts');
            counts.append(node('span', format(entry.used) + ' 使用済み'), node('span', format(entry.available) + ' 空き'));
            section.append(bar, counts);
        }
        list.append(section);
    }
    content.replaceChildren(list);
}

async function load() {
    const request = ++version;
    const requestedView = location.hash.slice(1);
    view = Object.hasOwn(titles, requestedView) ? requestedView : 'tv';
    if (view === 'guide' && from < dayStart(Date.now())) {
        from = dayStart(Date.now());
        guideScroll.top = 0;
    }
    if (view !== 'tv' && tv) {
        stopTv();
        tv = null;
    }
    const start = ['tv', 'search'].includes(view) ? Date.now() : view === 'guide' ? Math.max(from, Date.now()) : from;
    const end = view === 'search' ? Number.MAX_SAFE_INTEGER : start + day;
    const guideRequest = api('guide?from=' + start + '&to=' + end);
    const [nextGuide, nextState, settings, storage] = await Promise.all([guideRequest, ['tv', 'storage'].includes(view) ? null : api('state'),
        view === 'settings' ? api('settings') : null, view === 'storage' ? api('storage') : null]);
    if (request !== version) return;
    guide = nextGuide;
    const hidden = new Set(guide.guideHiddenChannels);
    const waves = ['GR', 'BS', 'CS'];
    const waveOrder = service => (waves.indexOf(service.channel?.type) + 4) % 4;
    const number = service => service.channel?.type === 'GR' ?
        Number(service.remoteControlKeyId) || 100 + (Number(service.channel.channel) || 0) : service.serviceId || service.id;
    visibleServices = guide.services.filter(service => !hidden.has(service.id))
        .sort((a, b) => waveOrder(a) - waveOrder(b) || number(a) - number(b) ||
            (a.serviceId || a.id) - (b.serviceId || b.id) || a.id - b.id);
    state = nextState;
    document.querySelector('#heading').textContent = titles[view];
    document.querySelector('main').dataset.view = view;
    if (view !== 'guide') document.querySelector('.heading').append(document.querySelector('#sync'));
    document.querySelector('#sync').hidden = view === 'storage';
    for (const item of document.querySelectorAll('nav a')) {
        if (item.hash === '#' + view) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
    }
    document.querySelector('#connection').textContent = guide.demo ? 'デモ · サンプル番組' :
        guide.syncError ? 'チューナー取得失敗 · ' + guide.syncError : 'チューナー接続済み';
    if (view === 'tv') renderTv();
    else if (view === 'guide') renderGuide(start);
    else if (view === 'search') renderSearch();
    else if (view === 'rules') renderRules();
    else if (view === 'settings') renderSettings(settings);
    else if (view === 'storage') renderStorage(storage.storage);
    else renderReservations();
}
const refreshView = () => load().catch(error => message(error.message));
async function refreshActivity() {
    const badges = document.querySelectorAll('.activity > span');
    if (!badges.length) return;
    let activity;
    let nextPoll = 5000;
    try {
        const response = await fetch('./api/activity', { signal: AbortSignal.timeout(4000) });
        if (response.ok) activity = await response.json();
        else if (response.status === 404) {
            nextPoll = 15000;
            const { reservations } = await api('state');
            activity = {
                recording: reservations.filter(row => row.status === 'recording').length,
                encoding: reservations.filter(row => row.encoding).length
            };
        }
    } catch { /* The next poll will retry. */ }
    for (const badge of badges) {
        const key = badge.id.replace('-activity', '');
        const value = badge.querySelector('b');
        const count = String(activity?.[key] ?? '–');
        if (value.textContent !== count) value.textContent = count;
        badge.dataset.active = String(activity?.[key] > 0);
    }
    setTimeout(refreshActivity, nextPoll);
}
void refreshActivity();
document.querySelector('#sync').onclick = async event => {
    const trigger = event.currentTarget;
    trigger.disabled = true;
    try { await mutate('sync', 'POST', undefined, '番組データを更新しました。'); }
    catch (error) { message(error.message); }
    finally { trigger.disabled = false; }
};
dialog.addEventListener('close', () => {
    const video = details.querySelector('video');
    if (video) {
        video.dispatchEvent(new Event('pause'));
        stopVideo(video);
    }
    details.replaceChildren();
    if (view === 'recordings') void refreshView();
});
window.addEventListener('hashchange', refreshView);
setInterval(() => {
    if (['reservations', 'recordings'].includes(view) && !dialog.open && !content.contains(document.activeElement)) void refreshView();
}, 5000);
setInterval(() => { if (view === 'tv') void refreshView(); }, 15_000);
void refreshView();
if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register(new URL('./sw.js', import.meta.url))
        .catch(error => console.warn('PWAの初期化に失敗しました', error));
}

