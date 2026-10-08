const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const streamEncodeJs = path.join(__dirname, '..', 'epgstation', 'scripts', 'streamEncode.js');

test('stopping during the probe window leaves no temporary file', { timeout: 10000 }, async t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-encode-test-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const child = spawn(process.execPath, [streamEncodeJs, 'live', 'm2ts', '720p', '/nonexistent/ffmpeg'], {
        env: { ...process.env, TMPDIR: tmp },
    });
    child.stdin.write(Buffer.alloc(188 * 100, 0x47)); // some TS bytes, far below the probe size
    const exited = new Promise(resolve => child.on('exit', resolve));

    // wait until the probe buffer file exists, then stop the stream as EPGStation does
    while (fs.readdirSync(tmp).length === 0) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    child.kill('SIGTERM');
    await exited;

    assert.deepStrictEqual(fs.readdirSync(tmp), []);
});
