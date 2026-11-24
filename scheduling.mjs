const normalize = value => value.normalize('NFKC').toLocaleLowerCase('ja');
const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
export const broadcastDate = value => new Date(value + 9 * 3_600_000).toISOString().slice(0, 10);
export const ruleServices = rule => rule.services ?? (rule.service == null ? [] : [rule.service]);

export function matchesRule(rule, program, wave) {
    const stations = ruleServices(rule);
    const text = normalize(program.title + ' ' + program.description);
    const title = normalize(program.title);
    const keyword = normalize(rule.keyword || '');
    const target = rule.keywordMatch === 'title' ? title : text;
    const words = value => rule.splitKeywords ? value.trim().split(/\s+/) : [value];
    const matchesKeyword = !keyword || (rule.keywordMatch === 'titleExact' ? title.trim() === keyword :
        words(keyword).every(word => target.includes(word)));
    const time = new Date(program.start + 9 * 3_600_000);
    const clock = time.toISOString().slice(11, 16);
    const inTime = !rule.from || (rule.from < rule.to
        ? clock >= rule.from && clock < rule.to
        : clock >= rule.from || clock < rule.to);
    return matchesKeyword &&
        (!rule.exclude || words(normalize(rule.exclude)).every(word => !text.includes(word))) &&
        (!rule.dateFrom || broadcastDate(program.start) >= rule.dateFrom) &&
        (!rule.dateTo || broadcastDate(program.start) <= rule.dateTo) &&
        (!stations.length || stations.includes(program.service)) &&
        (!rule.wave || rule.wave === wave) &&
        (rule.genre == null || program.genres?.includes(rule.genre)) &&
        (rule.subgenre == null || program.genreDetails?.some(({ lv1, lv2 }) => lv1 === rule.genre && lv2 === rule.subgenre)) &&
        (!rule.days?.length || rule.days.includes(weekdays[time.getUTCDay()])) && inTime;
}

// A tuner can serve multiple programs carried by the same physical channel.
export function fitsTuners(serviceIds, services, tuners) {
    if (tuners === null) return true;
    const multiplexes = new Map();
    for (const id of serviceIds) {
        const channel = services.get(id)?.channel;
        if (!channel?.type) continue;
        const key = channel.type + '/' + (channel.channel || id);
        multiplexes.set(key, channel.type);
    }
    const assigned = new Map();
    function assign(type, visited) {
        for (const [i, tuner] of tuners.entries()) {
            if (visited.has(i) || !tuner.types.includes(type)) continue;
            visited.add(i);
            if (!assigned.has(i) || assign(assigned.get(i), visited)) {
                assigned.set(i, type);
                return true;
            }
        }
        return false;
    }
    return [...multiplexes.values()].every(type => assign(type, new Set()));
}

export function reservationOrder(a, b) {
    return Number(Boolean(a.rule)) - Number(Boolean(b.rule)) ||
        a.start - b.start || (a.createdAt || 0) - (b.createdAt || 0);
}

export function predictConflicts(rows, services, tuners, now, startMarginSeconds = 0) {
    const accepted = [];
    const conflicts = new Set();
    const upcoming = rows.filter(row => ['scheduled', 'recording'].includes(row.status) && row.end > now)
        .map(row => ({ ...row, start: row.start - startMarginSeconds * 1000 }));
    upcoming.sort((a, b) => Number(b.status === 'recording') - Number(a.status === 'recording') || reservationOrder(a, b));
    for (const row of upcoming) {
        const overlapping = accepted.filter(r => r.start < row.end && r.end > row.start);
        const checkpoints = [Math.max(now, row.start), ...overlapping.filter(r => r.start > Math.max(now, row.start)).map(r => r.start)];
        if (row.status === 'recording' || checkpoints.every(at =>
            fitsTuners([row.service, ...overlapping.filter(r => r.start <= at && r.end > at).map(r => r.service)], services, tuners))) {
            accepted.push(row);
        } else conflicts.add(row.id);
    }
    return conflicts;
}
