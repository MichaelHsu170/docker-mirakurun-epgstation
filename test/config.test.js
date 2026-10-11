const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const configYml = path.join(__dirname, '..', 'epgstation', 'config', 'config.yml');

test('stream commands map only the first audio track, which every recording has', () => {
    // enc.js writes a single audio track unless the recording had two, so `-map 0:a:1` fails on most files
    const active = fs
        .readFileSync(configYml, 'utf8')
        .split('\n')
        .filter(line => !line.trim().startsWith('#'));

    assert.deepStrictEqual(
        active.filter(line => /-map 0:a:[1-9]/.test(line)),
        [],
    );
});

test('live and recorded TS HLS commands map only video and the first audio stream', () => {
    // ffmpeg 9 holds the video back while it waits for the next packet of a sparse or untimed stream (the captions'
    // ID3 track, EIT, superimpose): with `-map 0` live HLS writes no segment until the input ends, and recorded HLS
    // first reads the whole recording into memory. A 2nd audio stream that leaves the PMT mid-program does the same
    const lines = fs.readFileSync(configYml, 'utf8').split('\n');
    const hlsCmds = (from, to) => {
        const section = lines.slice(lines.indexOf(from), lines.indexOf(to));
        return section.slice(section.findIndex(line => line.trim() === 'hls:')).join(' ').split('cmd:').slice(1);
    };
    const cmds = [...hlsCmds('    live:', '    recorded:'), ...hlsCmds('    recorded:', '        encoded:')];

    assert.strictEqual(cmds.length, 4);
    for (const cmd of cmds) {
        assert.deepStrictEqual([...cmd.matchAll(/-map (\S+)/g)].map(m => m[1]), ['0:v', '0:a:0']);
    }
});

test('thumbnails are taken past the previous program at the start of a recording', () => {
    // a program recording starts with up to 8 MiB of the previous program (45 s at 1.5 Mbps) plus the broadcaster's
    // lag of up to 8.6 s (review D13-2: thumbnails at 5 s showed the previous program's promos and end cards)
    const positions = fs
        .readFileSync(configYml, 'utf8')
        .split('\n')
        .filter(line => line.startsWith('thumbnailPosition:'))
        .map(line => Number(line.split(':')[1]));

    assert.strictEqual(positions.length, 1);
    assert.ok(positions[0] > 45 + 8.6, `thumbnailPosition ${positions[0]} is inside the lead-in`);
});
