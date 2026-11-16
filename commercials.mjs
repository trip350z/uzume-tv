export function logoPreview(buffer) {
    const signature = buffer.toString('ascii', 0, 28).replace(/\0+$/, '');
    const nameSize = signature === '<logo data file ver0.1>' ? 32 :
        signature === '<logo data file ver0.2>' ? 256 : 0;
    const fileHeaderSize = 32;
    const headerSize = nameSize === 256 ? 512 : 48;
    if (!nameSize || buffer.length < fileHeaderSize + headerSize) throw new Error('ロゴデータの形式を読み取れません');

    const count = buffer.readUInt32BE(28);
    const dimensions = fileHeaderSize + nameSize;
    const x = buffer.readInt16LE(dimensions);
    const y = buffer.readInt16LE(dimensions + 2);
    const height = buffer.readInt16LE(dimensions + 4);
    const width = buffer.readInt16LE(dimensions + 6);
    const pixels = width * height;
    const start = fileHeaderSize + headerSize;
    if (!count || width <= 0 || height <= 0 || pixels > 1_048_576 || start + pixels * 12 > buffer.length) {
        throw new Error('ロゴデータのサイズが不正です');
    }

    const rgba = new Uint8ClampedArray(pixels * 4);
    const opacity = value => Math.max(0, Math.min(value / 1000, 1));
    for (let i = 0, offset = start; i < rgba.length; i += 4, offset += 12) {
        const alpha = opacity(buffer.readInt16LE(offset));
        if (!alpha) continue;
        const luma = buffer.readInt16LE(offset + 2) * 255 / 4096;
        const cb = buffer.readInt16LE(offset + 6) * 255 / 4096 * opacity(buffer.readInt16LE(offset + 4)) / alpha;
        const cr = buffer.readInt16LE(offset + 10) * 255 / 4096 * opacity(buffer.readInt16LE(offset + 8)) / alpha;
        rgba[i] = luma + 1.5748 * cr;
        rgba[i + 1] = luma - 0.1873 * cb - 0.4681 * cr;
        rgba[i + 2] = luma + 1.8556 * cb;
        rgba[i + 3] = alpha * 255;
    }
    return { x, y, width, height, count, rgba: Buffer.from(rgba).toString('base64') };
}

export function hasAmatsukazeLogoData(buffer) {
    if (buffer.length < 80 || buffer.toString('ascii', 0, 28).replace(/\0+$/, '') !== '<logo data file ver0.1>' ||
        buffer.readUInt32BE(28) !== 1) return false;
    const height = buffer.readInt16LE(68);
    const width = buffer.readInt16LE(70);
    const offset = 80 + width * height * 12;
    if (width <= 0 || height <= 0 || buffer.length < offset + 540 ||
        buffer.readUInt32LE(offset) !== 0x12345 || buffer.readUInt32LE(offset + 4) < 1 ||
        buffer.readInt32LE(offset + 8) !== width || buffer.readInt32LE(offset + 12) !== height) return false;
    const uvX = buffer.readUInt32LE(offset + 16);
    const uvY = buffer.readUInt32LE(offset + 20);
    return uvX <= 2 && uvY <= 2 && buffer.length >= offset + 540 +
        (width * height + 2 * (width >> uvX) * (height >> uvY)) * 8;
}

export function parseCommercials(edl) {
    const cuts = [];
    for (const line of edl.trim().split(/\r?\n/)) {
        const [start, end, action] = line.trim().split(/\s+/).map(Number);
        if ((action === 0 || action === 3) && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) {
            cuts.push({ start, end });
        }
    }
    return cuts.sort((a, b) => a.start - b.start);
}

export function joinLogoCuts(text, fps, duration) {
    if (!(fps > 0 && Number.isFinite(fps))) throw new Error('映像のフレームレートを取得できません');
    const line = text.split(/\r?\n/).find(line => /^\s*Trim\(/i.test(line));
    if (!line || !/^\s*Trim\(\s*\d+\s*,\s*\d+\s*\)(?:\s*\+{1,2}\s*Trim\(\s*\d+\s*,\s*\d+\s*\))*\s*$/i.test(line)) {
        throw new Error('join_logo_scpの保持区間を読み取れません');
    }
    const cuts = [];
    let cursor = 0;
    for (const [, first, last] of line.matchAll(/Trim\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi)) {
        const start = Number(first);
        const end = Number(last);
        if (!Number.isSafeInteger(end) || end < start || start < cursor || start / fps >= duration) {
            throw new Error('join_logo_scpの保持区間が不正です');
        }
        if (start > cursor) cuts.push({ start: cursor / fps, end: start / fps });
        cursor = end + 1;
    }
    if (duration - cursor / fps > 2 / fps) cuts.push({ start: cursor / fps, end: duration });
    return cuts;
}

export function commercialFilters(cuts, hasAudio) {
    const remove = cuts.map(({ start, end }) => 'gte(t,' + start + ')*lt(t,' + end + ')').join('+');
    // FFmpeg already offsets the input streams to a common origin. Keep that
    // origin when decoding skips the first few video frames of a TS recording.
    const removedTime = cuts.map(({ start, end }) => '(' + end + '-' + start + ')*gte(T,' + end + ')').join('+');
    const filters = ['-vf', "select='not(" + remove + ")',setpts='PTS-(" + removedTime + ")/TB',yadif=deint=interlaced"];
    if (!hasAudio) return filters;

    const keep = [];
    let start = 0;
    for (const cut of cuts) {
        if (start < cut.start) keep.push('start=' + start + ':end=' + cut.start);
        start = cut.end;
    }
    keep.push('start=' + start);

    const reset = 'asetpts=PTS-STARTPTS';
    const align = 'aresample=async=1:first_pts=0';
    if (keep.length === 1) return [...filters, '-af', align + ',atrim=' + keep[0] + ',' + reset];

    const inputs = keep.map((_, index) => '[a' + index + ']');
    const outputs = keep.map((_, index) => '[k' + index + ']');
    const segments = keep.map((interval, index) => inputs[index] + 'atrim=' + interval + ',' + reset + outputs[index]);
    const graph = [align + ',asplit=' + keep.length + inputs.join(''), ...segments,
        outputs.join('') + 'concat=n=' + keep.length + ':v=0:a=1'];
    return [...filters, '-af', graph.join(';')];
}

export function cutCaptions(vtt, cuts) {
    const seconds = stamp => stamp.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
    const stamp = value => {
        const ms = Math.round(value * 1000);
        return String(Math.floor(ms / 3600000)).padStart(2, '0') + ':' + new Date(ms).toISOString().slice(14, 23);
    };
    const shift = value => value - cuts.reduce((sum, cut) => sum + Math.max(0, Math.min(value, cut.end) - cut.start), 0);
    return vtt.trimEnd().split(/\r?\n\r?\n/).map(block => {
        const timing = /^(\d[\d:.]*) --> (\d[\d:.]*)/m.exec(block);
        if (!timing) return block;
        const start = shift(seconds(timing[1]));
        const end = shift(seconds(timing[2]));
        return end - start >= .001 ? block.replace(timing[0], stamp(start) + ' --> ' + stamp(end)) : '';
    }).filter(Boolean).join('\n\n') + '\n';
}
