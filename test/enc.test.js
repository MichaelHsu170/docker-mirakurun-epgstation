const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const encJs = path.join(__dirname, '..', 'epgstation', 'scripts', 'enc.js');

/**
 * Writes a fake ffprobe that reports no audio, 100 s for the input and outputDuration for the
 * output ('fail': ffprobe fails), and a fake ffmpeg running ffmpegScript, into dir.
 */
const writeFakes = (dir, ffmpegScript, outputDuration = '100') => {
    const ffprobe = path.join(dir, 'ffprobe');
    fs.writeFileSync(
        ffprobe,
        '#!/bin/sh\nfor a; do last="$a"; done\n' +
            `case "$last" in *.mkv) d='${outputDuration}';; *) d='100';; esac\n` +
            '[ "$d" = fail ] && exit 1\n' +
            'echo "{\\"format\\":{\\"duration\\":\\"$d\\"},\\"streams\\":[]}"\n',
        { mode: 0o755 },
    );
    const ffmpeg = path.join(dir, 'ffmpeg');
    fs.writeFileSync(ffmpeg, `#!/bin/sh\n${ffmpegScript}\n`, { mode: 0o755 });

    return {
        ...process.env,
        FFMPEG: ffmpeg,
        FFPROBE: ffprobe,
        INPUT: path.join(dir, 'in.m2ts'),
        OUTPUT: path.join(dir, 'out.mkv'),
    };
};

/**
 * Runs enc.js (CPU mode) with the fakes of writeFakes. Returns spawnSync's result.
 */
const runEncResult = (ffmpegScript, outputDuration) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-'));
    try {
        return spawnSync(process.execPath, [encJs, 'cpu'], { env: writeFakes(dir, ffmpegScript, outputDuration) });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

const runEnc = (ffmpegScript, outputDuration) => runEncResult(ffmpegScript, outputDuration).status;

test('exits 0 when ffmpeg succeeds', () => {
    assert.strictEqual(runEnc('exit 0'), 0);
});

test('passes on the exit code when ffmpeg fails', () => {
    assert.strictEqual(runEnc('exit 3'), 3);
});

test('fails when ffmpeg is killed by a signal', () => {
    assert.strictEqual(runEnc('kill -9 $$'), 1);
});

test('exits 0 when the output is at least 97% of the input', () => {
    assert.strictEqual(runEnc('exit 0', '97'), 0);
});

test('fails when the output is shorter than 97% of the input', () => {
    assert.strictEqual(runEnc('exit 0', '96.9'), 1);
});

test('fails when the output duration cannot be read', () => {
    assert.strictEqual(runEnc('exit 0', 'N/A'), 1);
});

test('fails when ffprobe cannot read the output', () => {
    assert.strictEqual(runEnc('exit 0', 'fail'), 1);
});

test('reports progress from ffmpeg 9 progress lines (KiB sizes)', () => {
    const line = 'frame= 2400 fps= 60 q=29.0 size=   12288KiB time=00:00:50.00 bitrate=2013.3kbits/s speed=1.98x elapsed=0:00:25.25';
    const result = runEncResult(`printf '%s\\r' '${line}' >&2`);

    const progress = String(result.stdout)
        .split('\n')
        .filter(l => l.startsWith('{'))
        .map(l => JSON.parse(l));
    assert.strictEqual(progress.length, 1);
    assert.strictEqual(progress[0].type, 'progress');
    assert.strictEqual(progress[0].percent, 0.5);
});

test('cancelling stops ffmpeg even though EPGStation closes the output pipes first', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-'));
    const pidFile = path.join(dir, 'ffmpeg.pid');
    const marker = path.join(dir, 'got-sigint');
    t.after(() => {
        // never leave the fake ffmpeg running, even when the test fails
        try {
            process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
        } catch (err) {}
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const env = writeFakes(
        dir,
        `echo $$ > '${pidFile}'\ntrap "touch '${marker}'; exit 255" INT\n` +
            "while true; do printf 'frame= 1 fps= 1 q=1.0 size= 1KiB time=00:00:01.00 bitrate=1.0kbits/s speed=1x\\r' >&2; sleep 0.05; done",
    );

    const enc = spawn(process.execPath, [encJs, 'cpu'], { env });
    const exited = new Promise(resolve => enc.on('exit', resolve));
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    while (!fs.existsSync(pidFile)) {
        await sleep(50);
    }
    await sleep(300);

    // what EPGStation's ProcessUtil.kill does: destroy stdout/stderr, then SIGINT 500 ms later
    enc.stdout.destroy();
    enc.stderr.destroy();
    await sleep(500);
    enc.kill('SIGINT');
    await Promise.race([exited, sleep(3000)]);
    await sleep(300);

    assert.strictEqual(fs.existsSync(marker), true, 'ffmpeg did not receive SIGINT');
});
