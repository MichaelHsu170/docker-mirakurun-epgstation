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
