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

test('live and recorded TS HLS commands map only video and audio', () => {
    // ffmpeg 9 holds the video back while it waits for the next packet of a sparse or untimed stream (the captions'
    // ID3 track, EIT, superimpose): with `-map 0` live HLS writes no segment until the input ends, and recorded HLS
    // first reads the whole recording into memory
    const lines = fs.readFileSync(configYml, 'utf8').split('\n');
    const hlsCmds = (from, to) => {
        const section = lines.slice(lines.indexOf(from), lines.indexOf(to));
        return section.slice(section.findIndex(line => line.trim() === 'hls:')).join(' ').split('cmd:').slice(1);
    };
    const cmds = [...hlsCmds('    live:', '    recorded:'), ...hlsCmds('    recorded:', '        encoded:')];

    assert.strictEqual(cmds.length, 4);
    for (const cmd of cmds) {
        assert.deepStrictEqual([...cmd.matchAll(/-map (\S+)/g)].map(m => m[1]), ['0:v', '0:a']);
    }
});
