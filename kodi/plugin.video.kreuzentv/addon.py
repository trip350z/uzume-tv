import json
import sys
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError
from urllib.parse import parse_qsl, urlencode
from urllib.request import Request, urlopen
from unicodedata import normalize

import xbmc
import xbmcaddon
import xbmcgui
import xbmcplugin

ADDON = xbmcaddon.Addon()
BASE = (ADDON.getSetting('server') or 'http://192.168.100.205:8781').rstrip('/')
HANDLE = int(sys.argv[1])
PARAMS = dict(parse_qsl(sys.argv[2].lstrip('?')))
DIALOG = xbmcgui.Dialog()
JST = timezone(timedelta(hours=9))
DAY = 86400000
ACTIVE = ('scheduled', 'recording')
WAVE_LABELS = {'GR': '地上波', 'BS': 'BS', 'CS': 'CS', 'SKY': 'スカパー！'}


def api(path, method='GET', payload=None):
    data = None if payload is None else json.dumps(payload).encode('utf-8')
    request = Request(BASE + '/api/' + path, data=data, method=method,
                      headers={'Content-Type': 'application/json'} if data is not None else {})
    try:
        with urlopen(request, timeout=12) as response:
            return json.load(response)
    except HTTPError as error:
        try:
            message = json.load(error)['error']
        except (ValueError, KeyError):
            message = str(error)
        raise RuntimeError(message) from error


def route(action, **params):
    return sys.argv[0] + '?' + urlencode({'action': action, **params})


def item(title, action, *, playable=False, art=None, plot='', **params):
    entry = xbmcgui.ListItem(label=title)
    if plot:
        info = entry.getVideoInfoTag()
        info.setTitle(title)
        info.setPlot(plot)
    if art:
        entry.setArt({'thumb': art, 'icon': art})
    if playable:
        entry.setProperty('IsPlayable', 'true')
    xbmcplugin.addDirectoryItem(HANDLE, route(action, **params), entry, not playable)


def clock(timestamp, pattern='%m/%d %H:%M'):
    return datetime.fromtimestamp(timestamp / 1000, JST).strftime(pattern)


def guide(days=1, offset=0):
    now = int(datetime.now(JST).timestamp() * 1000)
    start = now + offset * DAY
    return guide_range(start, start + DAY * days)


def guide_range(start, end):
    data = api('guide?' + urlencode({'from': start, 'to': end}))
    hidden = set(data.get('guideHiddenChannels', []))
    stations = {s['id']: s for s in data['services'] if s['id'] not in hidden}
    return data, stations


def station_wave(station):
    return (station.get('channel') or {}).get('type') or 'その他'


def station_logo(station_id):
    return BASE + '/api/logos/' + str(station_id)


def ordered_stations(stations):
    def key(station):
        wave = station_wave(station)
        return (list(WAVE_LABELS).index(wave) if wave in WAVE_LABELS else len(WAVE_LABELS),
                (station.get('remoteControlKeyId') or 100) if wave == 'GR' else 0,
                station.get('serviceId') or station['id'])
    return sorted(stations.values(), key=key)


def show_guide():
    now = datetime.now(JST)
    now_ms = int(now.timestamp() * 1000)
    mode = PARAMS.get('mode', 'day')
    offset = int(PARAMS.get('offset', 0))
    if mode == 'on-air':
        start, end = now_ms, now_ms + DAY
    else:
        midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
        day_start = int(midnight.timestamp() * 1000) + offset * DAY
        start, end = max(day_start, now_ms), day_start + DAY
    data, stations = guide_range(start, end)
    by_station = {station_id: [] for station_id in stations}
    for program in sorted(data['programs'], key=lambda p: p['start']):
        if program['service'] in by_station:
            by_station[program['service']].append(program)
    if 'station' in PARAMS:
        station_id = int(PARAMS['station'])
        programs = by_station.get(station_id, [])
        if not programs:
            DIALOG.notification('KreuzenTV', '表示できる番組がありません')
        program_entries(programs, stations, compact=True, now=now_ms)
        return
    selected_wave = PARAMS.get('wave')
    if selected_wave is None:
        for wave in dict.fromkeys(station_wave(s) for s in ordered_stations(stations)):
            item(WAVE_LABELS.get(wave, wave), 'guide', mode=mode, offset=offset, wave=wave)
        return
    for station in ordered_stations(stations):
        if station_wave(station) != selected_wave:
            continue
        programs = by_station[station['id']]
        if mode == 'on-air':
            current = next((p for p in programs if p['start'] <= now_ms < p['end']), None)
            following = next((p for p in programs if p['start'] > now_ms), None)
            label = station['name'] + '  |  ' + (current['title'] if current else '放送中の番組情報なし')
            if following:
                label += '  ›  ' + clock(following['start'], '%H:%M') + ' ' + following['title']
        else:
            label = station['name'] + '  ·  ' + str(len(programs)) + ' 番組'
        item(label, 'guide', mode=mode, offset=offset, station=station['id'], art=station_logo(station['id']))


def recording_options(state, existing=None):
    options = dict(existing or {})
    destinations = state.get('destinations', ['default'])
    labels = ['既定の保存先' if x == 'default' else x for x in destinations]
    index = DIALOG.select('TS保存先', labels, preselect=destinations.index(options['destination'])
                          if options.get('destination') in destinations else 0)
    if index < 0:
        return None
    options['destination'] = destinations[index]
    encode_destinations = [''] + destinations
    index = DIALOG.select('MP4保存先', ['TSと同じ'] + labels,
                          preselect=encode_destinations.index(options['encodeDestination'])
                          if options.get('encodeDestination') in encode_destinations else 0)
    if index < 0:
        return None
    options['encodeDestination'] = encode_destinations[index]
    options['subDirectory'] = DIALOG.input('サブフォルダ（例 ドラマ/2026）', options.get('subDirectory', '')).strip()
    profiles = state.get('encodeProfiles', [])
    profile_names = [''] + [p['name'] for p in profiles]
    index = DIALOG.select('エンコードプロファイル', ['既定'] + profile_names[1:],
                          preselect=profile_names.index(options['encodeProfile'])
                          if options.get('encodeProfile') in profile_names else 0)
    if index < 0:
        return None
    options['encodeProfile'] = profile_names[index]
    options['recordedFormat'] = DIALOG.input('ファイル名の書式（空欄は既定）', options.get('recordedFormat', ''))
    options['fileName'] = 'default'
    options['autoEncode'] = DIALOG.yesno('KreuzenTV', '録画後にMP4へ自動変換しますか？')
    options['deleteOriginal'] = options['autoEncode'] and DIALOG.yesno('KreuzenTV', '変換成功後に元のTSを削除しますか？')
    return options


def rule_editor(preset=None):
    rule = dict(preset or {})
    keyword = DIALOG.input('自動予約のキーワード', rule.get('keyword', ''))
    if not keyword.strip():
        return
    mode = DIALOG.select('キーワードの照合', ['番組名・説明に含む', '番組名に含む', '番組名と完全一致'],
                         preselect=['text', 'title', 'titleExact'].index(rule.get('keywordMatch', 'text')))
    if mode < 0:
        return
    rule['keyword'] = keyword.strip()
    rule['keywordMatch'] = ['text', 'title', 'titleExact'][mode]
    rule['exclude'] = DIALOG.input('除外キーワード', rule.get('exclude', ''))
    _, stations = guide()
    station_ids = [s['id'] for s in ordered_stations(stations)]
    previously_selected = rule.get('services', [rule.get('service')])
    indexes = DIALOG.multiselect('放送局（未選択なら全局）', [stations[s]['name'] for s in station_ids],
                                 preselect=[i for i, s in enumerate(station_ids) if s in previously_selected])
    if indexes is None:
        return
    rule['services'] = [station_ids[i] for i in indexes]
    rule['service'] = next(iter(rule['services']), None)
    rule['wave'] = ''
    index = DIALOG.select('同じ放送回の予約', ['すべて予約する', '番組名・回番号・説明が一致する放送を除く'],
                          preselect=int(rule.get('skipDuplicateEpisodes', False)))
    if index < 0:
        return
    rule['skipDuplicateEpisodes'] = bool(index)
    saved = recording_options(api('state'), rule.get('options'))
    if saved is None:
        return
    rule['options'] = saved
    rule_id = rule.pop('id', None)
    rule.pop('enabled', None)
    if DIALOG.yesno('自動予約', 'このルールを保存しますか？'):
        api('rules/' + rule_id if rule_id else 'rules', 'PATCH' if rule_id else 'POST', rule)
        DIALOG.notification('KreuzenTV', '自動予約ルールを保存しました')


def program_entries(programs, stations, *, compact=False, now=0):
    for p in programs[:1000]:
        station = stations.get(p['service'])
        if station:
            if compact:
                time_range = clock(p['start'], '%H:%M') + '–' + clock(p['end'], '%H:%M')
                title = ('放送中  ' if p['start'] <= now < p['end'] else '') + time_range + '  ' + p['title']
            else:
                title = clock(p['start']) + '  ' + station['name'] + '  ' + p['title']
            item(title, 'program', id=p['id'], at=p['start'], art=station_logo(station['id']),
                 plot=p.get('description', ''))


def run(action):
    if action == 'home':
        for title, target in [('ライブ視聴', 'live'), ('番組表', 'guide-home'), ('番組検索', 'search'),
                              ('録画一覧', 'recordings'), ('予約', 'reservations'), ('自動予約', 'rules'),
                              ('接続設定', 'settings')]:
            item(title, target)
    elif action == 'settings':
        ADDON.openSettings()
    elif action in ('play-live', 'play-recording'):
        path = ('live/' + PARAMS['id']) if action == 'play-live' else (
            'reservations/' + PARAMS['id'] + '/' + PARAMS['format'])
        xbmcplugin.setResolvedUrl(HANDLE, True, xbmcgui.ListItem(path=BASE + '/api/' + path))
        return False
    elif action == 'live':
        _, stations = guide()
        for station in stations.values():
            wave = station.get('channel', {}).get('type') or 'その他'
            if PARAMS.get('wave') == wave:
                item(station['name'], 'play-live', id=station['id'], playable=True,
                     art=BASE + '/api/logos/' + str(station['id']))
        if 'wave' not in PARAMS:
            for wave in dict.fromkeys(s.get('channel', {}).get('type') or 'その他' for s in stations.values()):
                item('地上波' if wave == 'GR' else wave, 'live', wave=wave)
    elif action == 'guide-home':
        item('放送中・次の番組', 'guide', mode='on-air')
        item('今日の番組表', 'guide', offset=0)
        item('日付から探す', 'days')
    elif action == 'days':
        weekday = '月火水木金土日'
        for offset in range(8):
            day = datetime.now(JST) + timedelta(days=offset)
            item(day.strftime('%m/%d') + '（' + weekday[day.weekday()] + '）', 'guide', offset=offset)
    elif action == 'guide':
        show_guide()
    elif action == 'search':
        keyword = normalize('NFKC', DIALOG.input('番組名・説明を検索')).strip().casefold()
        if keyword:
            data, stations = guide(8)
            program_entries([p for p in data['programs'] if keyword in
                             normalize('NFKC', p['title'] + ' ' + p.get('description', '')).casefold()], stations)
    elif action == 'program':
        at = int(PARAMS['at'])
        data = api('guide?' + urlencode({'from': at, 'to': at + 1}))
        p = next((p for p in data['programs'] if str(p['id']) == PARAMS['id']), None)
        if not p:
            raise RuntimeError('番組情報が見つかりません')
        choice = DIALOG.contextmenu(['番組詳細', '録画予約', '自動予約ルールを作成'])
        if choice == 0:
            DIALOG.textviewer(p['title'], p.get('description') or '番組説明はありません。')
        elif choice == 1:
            options = recording_options(api('state'))
            if options is not None and DIALOG.yesno('録画予約', p['title']):
                api('reservations', 'POST', {'programId': p['id'], 'options': options})
                DIALOG.notification('KreuzenTV', '録画予約を登録しました')
        elif choice == 2:
            rule_editor({'keyword': p['title'], 'keywordMatch': 'title', 'service': p['service']})
    elif action == 'recordings':
        rows = api('state')['reservations']
        for row in sorted(rows, key=lambda r: r['start'], reverse=True):
            if row['status'] not in ACTIVE and (row['mp4'] or row['ts']):
                item(clock(row['start']) + '  ' + row['title'], 'play-recording', id=row['id'],
                     format='mp4' if row['mp4'] else 'stream', playable=True,
                     art=BASE + '/api/reservations/' + row['id'] + '/thumbnail', plot=row.get('description', ''))
    elif action == 'reservations':
        for row in sorted(api('state')['reservations'], key=lambda r: r['start']):
            if row['status'] in ACTIVE:
                label = '録画中' if row['status'] == 'recording' else '競合' if row.get('conflict') else '予約'
                item(label + '  ' + clock(row['start']) + '  ' + row['title'], 'manage-reservation', id=row['id'])
    elif action == 'manage-reservation':
        state = api('state')
        row = next((r for r in state['reservations'] if r['id'] == PARAMS['id'] and r['status'] in ACTIVE), None)
        if row is None:
            raise RuntimeError('予約が見つかりません')
        path = 'reservations/' + row['id']
        editable = row['status'] == 'scheduled' and row['start'] > int(datetime.now(JST).timestamp() * 1000)
        actions = ['編集', '予約取消'] if editable else ['予約取消・録画停止']
        choice = DIALOG.contextmenu(actions)
        if editable and choice == 0:
            options = recording_options(state, row.get('options'))
            if options is not None and DIALOG.yesno('予約の変更', row['title']):
                api(path, 'PATCH', {'options': options})
                DIALOG.notification('KreuzenTV', '予約を更新しました')
                xbmc.executebuiltin('Container.Refresh')
        elif choice >= 0 and DIALOG.yesno(actions[choice], row['title']):
            api(path + '/cancel', 'POST')
            xbmc.executebuiltin('Container.Refresh')
    elif action == 'rules':
        item('ルールを作成', 'new-rule')
        for rule in api('state')['rules']:
            item(('有効' if rule['enabled'] else '無効') + '  ' + (rule.get('keyword') or '条件指定'),
                 'manage-rule', id=rule['id'])
    elif action == 'new-rule':
        rule_editor()
    elif action == 'manage-rule':
        rule = next((r for r in api('state')['rules'] if r['id'] == PARAMS['id']), None)
        if rule:
            choice = DIALOG.contextmenu(['編集', '無効にする' if rule['enabled'] else '有効にする', '削除'])
            if choice == 0:
                rule_editor(rule)
            elif choice == 1:
                api('rules/' + rule['id'], 'PATCH', {'enabled': not rule['enabled']})
            elif choice == 2 and DIALOG.yesno('ルール削除', rule.get('keyword') or '条件指定'):
                api('rules/' + rule['id'], 'DELETE')
            if choice >= 0:
                xbmc.executebuiltin('Container.Refresh')
    return action in ('home', 'live', 'guide-home', 'days', 'guide', 'search', 'recordings', 'reservations', 'rules')


action = PARAMS.get('action', 'home')
try:
    listing = run(action)
    if not action.startswith('play-'):
        xbmcplugin.endOfDirectory(HANDLE, succeeded=listing, cacheToDisc=False)
except (OSError, RuntimeError, ValueError, KeyError) as error:
    DIALOG.ok('KreuzenTV', str(error))
    if action.startswith('play-'):
        xbmcplugin.setResolvedUrl(HANDLE, False, xbmcgui.ListItem())
    else:
        xbmcplugin.endOfDirectory(HANDLE, succeeded=False, cacheToDisc=False)
