import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const library = './subtitle-tools/node_modules/aribb24.js/dist/cjs/';

export async function readLiveCaptions(source, publish) {
    const demux = require(library + 'lib/demuxer/mpegts/index.js').default;
    const { ARIBB24Parser } = require(library + 'lib/parser/parser.js');
    const { getTokenizeInformation } = require(library + 'runtime/cli/info.js');
    let language;
    for await (const { pts, data } of demux(source, { offset: 'VIDEO', type: 'Caption' })) {
        if (data.tag === 'CaptionManagement') {
            language = data.languages.find(item => item.iso_639_language_code === 'jpn') ?? data.languages[0];
            continue;
        }
        if (!language || data.lang !== language.lang || !Number.isFinite(pts)) continue;
        const [, tokenizer, state] = getTokenizeInformation(language.iso_639_language_code, language.TCS, 'ARIB');
        const tokens = new ARIBB24Parser(state, { magnification: 2 }).parse(tokenizer.tokenize(data));
        const lines = new Map();
        let duration = 8;
        for (const token of tokens) {
            if (token.tag === 'ClearScreen' && token.time > 0) duration = token.time;
            if (token.tag !== 'Character') continue;
            const [x, y] = token.state.position;
            if (!lines.has(y)) lines.set(y, new Map());
            lines.get(y).set(x, token.character);
        }
        const text = [...lines].sort(([a], [b]) => a - b)
            .map(([, line]) => [...line].sort(([a], [b]) => a - b).map(([, char]) => char).join('').trim())
            .filter(Boolean).join('\n');
        publish({ start: Math.max(0, pts), duration, text });
    }
}
