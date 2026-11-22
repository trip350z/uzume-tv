import { lstatSync, statSync, unlinkSync } from 'node:fs';
import { statfs } from 'node:fs/promises';

export async function reclaimRecordingSpace(location, minimumBytes, candidates, inspect, isBusy) {
    if (!minimumBytes) return;
    const disk = await statfs(location, { bigint: true });
    if (disk.bavail * disk.bsize >= minimumBytes) return;
    const device = statSync(location).dev;
    for (const item of candidates.sort((a, b) => a.start - b.start)) {
        try {
            if (isBusy(item.id)) continue;
            const ts = lstatSync(item.ts);
            const mp4 = lstatSync(item.mp4);
            if (!ts.isFile() || !mp4.isFile() || !mp4.size || ts.dev !== device ||
                ts.ino === mp4.ino && ts.dev === mp4.dev) continue;
            if (!await inspect(item.mp4)) continue;
            if (isBusy(item.id)) continue;
            const space = await statfs(location, { bigint: true });
            if (space.bavail * space.bsize >= minimumBytes) return;
            const currentTs = lstatSync(item.ts);
            const currentMp4 = lstatSync(item.mp4);
            if (currentTs.ino !== ts.ino || currentTs.dev !== ts.dev || currentTs.size !== ts.size ||
                currentMp4.ino !== mp4.ino || currentMp4.dev !== mp4.dev ||
                currentMp4.size !== mp4.size || currentMp4.mtimeMs !== mp4.mtimeMs) continue;
            if (isBusy(item.id)) continue;
            unlinkSync(item.ts);
            console.info('空き容量確保のため変換済みTSを削除しました', item.id, item.ts);
        } catch (error) {
            console.warn('録画容量の確保をスキップしました', item.id, error.message);
        }
    }
}
