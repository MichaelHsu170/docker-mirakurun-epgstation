const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFakeTools } = require('./fakeTools.js');

const encJs = path.join(__dirname, '..', 'epgstation', 'scripts', 'enc.js');

/**
 * Writes the fake ffprobe and ffmpeg of fakeTools.js (ffmpeg running ffmpegScript, with the other
 * options in tools) into dir. Returns the environment enc.js runs with.
 */
const writeFakes = (dir, ffmpegScript, tools = {}) => {
    const { ffmpeg, ffprobe } = writeFakeTools(dir, { ffmpegScript, ...tools });

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
const runEncResult = (ffmpegScript, tools) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-'));
    try {
        return spawnSync(process.execPath, [encJs, 'cpu'], { env: writeFakes(dir, ffmpegScript, tools) });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

const runEnc = (ffmpegScript, tools) => runEncResult(ffmpegScript, tools).status;

/** The progress events enc.js printed to stdout */
const progressOf = result =>
    String(result.stdout)
        .split('\n')
        .filter(l => l.startsWith('{'))
        .map(l => JSON.parse(l));

/** A progress line of ffmpeg 9 at the given time (hh:mm:ss.cc) */
const progressLine = time =>
    `frame= 2400 fps= 60 q=29.0 size=   12288KiB time=${time} bitrate=2013.3kbits/s speed=1.98x elapsed=0:00:25.25`;

test('exits 0 when ffmpeg succeeds', () => {
    assert.strictEqual(runEnc('exit 0'), 0);
});

test('passes on the exit code when ffmpeg fails', () => {
    assert.strictEqual(runEnc('exit 3'), 3);
});

test('fails when ffmpeg is killed by a signal', () => {
    assert.strictEqual(runEnc('kill -9 $$'), 1);
});

test('exits 0 when at most 5 s of the input are missing from the output', () => {
    assert.strictEqual(runEnc('exit 0', { outputDuration: '96' }), 0);
    assert.strictEqual(runEnc('exit 0', { outputDuration: '95' }), 0);
});

test('fails when more than 5 s of the input are missing from the output', () => {
    assert.strictEqual(runEnc('exit 0', { outputDuration: '94' }), 1);
});

test('fails when 10 s of a one-hour input are missing from the output', () => {
    assert.strictEqual(runEnc('exit 0', { inputDuration: '3600', outputDuration: '3590' }), 1);
});

/** A shell command printing ffmpeg 9's timestamp discontinuity warnings with the given offsets (µs) to stderr */
const discontinuities = (...offsets) =>
    offsets
        .map(
            (offset, i) =>
                `printf '%s\\n' '[aist#0:3/aac @ 0x5f] timestamp discontinuity (stream id=273): ${i}, new offset= ${offset}' >&2; `,
        )
        .join('');

test('exits 0 when the output is short only by the time ffmpeg closed up at timestamp discontinuities', () => {
    // the 81 s slice of a recording with a 10.176 s reception dropout: offset -10.176 s, output 10.17 s shorter
    const result = runEncResult(`${discontinuities(-10176000)}exit 0`, { inputDuration: '79.342066', outputDuration: '69.169' });

    assert.strictEqual(result.status, 0);
    assert.match(
        String(result.stderr),
        /^enc\.js: output is 69\.169s, input is 79\.342066s: ffmpeg closed up 10\.176s of timestamp gaps \(no data in the input\), so the output is complete$/m,
    );
});

test('allows the closed-up time on top of the 5 s', () => {
    assert.strictEqual(runEnc(`${discontinuities(-10000000)}exit 0`, { outputDuration: '85' }), 0);
    assert.strictEqual(runEnc(`${discontinuities(-10000000)}exit 0`, { outputDuration: '84.9' }), 1);
});

test('takes the closed-up time from the last offset, which is cumulative', () => {
    // as ffmpeg reports one gap: the audio jumps, the video then appears to jump back, then the audio again
    assert.strictEqual(runEnc(`${discontinuities(-10176000, 1, -10176000)}exit 0`, { outputDuration: '85' }), 0);
    // a jump that was undone later closed nothing up
    assert.strictEqual(runEnc(`${discontinuities(-10176000, 1)}exit 0`, { outputDuration: '85' }), 1);
});

test('does not ask for a longer output when ffmpeg shifted the timestamps forward', () => {
    assert.strictEqual(runEnc(`${discontinuities(3000000)}exit 0`, { outputDuration: '95' }), 0);
});

test('fails a truncated output despite closed-up gaps, naming the closed-up time', () => {
    const result = runEncResult(`${discontinuities(-10176000)}exit 0`, { inputDuration: '79.342066', outputDuration: '48.312' });

    assert.strictEqual(result.status, 1);
    assert.match(
        String(result.stderr),
        /^enc\.js: output is 48\.312s, input is 79\.342066s, of which ffmpeg closed up 10\.176s of timestamp gaps: treating the encode as failed$/m,
    );
});

test('does not check the output when the input duration cannot be read', () => {
    assert.strictEqual(runEnc('exit 0', { inputDuration: 'N/A', outputDuration: '10' }), 0);
    assert.strictEqual(runEnc('exit 0', { inputDuration: '0', outputDuration: '10' }), 0);
});

test('fails when the output duration cannot be read', () => {
    assert.strictEqual(runEnc('exit 0', { outputDuration: 'N/A' }), 1);
});

test('fails when ffprobe cannot read the output', () => {
    assert.strictEqual(runEnc('exit 0', { outputDuration: 'fail' }), 1);
});

test('reports progress from ffmpeg 9 progress lines (KiB sizes)', () => {
    const result = runEncResult(`printf '%s\\r' '${progressLine('00:00:50.00')}' >&2`);

    const progress = progressOf(result);
    assert.strictEqual(progress.length, 1);
    assert.strictEqual(progress[0].type, 'progress');
    assert.strictEqual(progress[0].percent, 0.5);
});

test('forwards ffmpeg messages that follow a progress line in the same output, and reports every progress line', () => {
    const output =
        `${progressLine('00:00:10.00')}\\r[mpegts @ 0x55] Packet corrupt (stream = 0, dts = 1)\\n` +
        `${progressLine('00:00:20.00')}\\r${progressLine('00:00:30.00')}\\r`;
    const result = runEncResult(`printf '${output}' >&2`);

    assert.deepStrictEqual(
        progressOf(result).map(p => p.percent),
        [0.1, 0.2, 0.3],
    );
    assert.match(String(result.stderr), /^\[mpegts @ 0x55\] Packet corrupt \(stream = 0, dts = 1\)$/m);
});

test('joins a line that ffmpeg writes in two parts', () => {
    const line = progressLine('00:00:40.00');
    const result = runEncResult(
        `printf '%s' '${line.slice(0, 30)}' >&2; sleep 0.2; printf '%s\\r[aac @ 0x56] Input buffer exhausted' '${line.slice(30)}' >&2`,
    );

    assert.deepStrictEqual(
        progressOf(result).map(p => p.percent),
        [0.4],
    );
    assert.match(String(result.stderr), /^\[aac @ 0x56\] Input buffer exhausted$/m);
});

test('splits dual-mono audio into a Japanese and an English track', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-'));
    try {
        const argsFile = path.join(dir, 'args');
        const env = writeFakes(dir, `printf '%s\\n' "$@" > '${argsFile}'`, { audioStreams: 1, dualMono: true });

        assert.strictEqual(spawnSync(process.execPath, [encJs, 'cpu'], { env }).status, 0);

        const args = fs.readFileSync(argsFile, 'utf8').trimEnd().split('\n');
        assert.deepStrictEqual(args, [
            '-y', '-fix_sub_duration', '-analyzeduration', '30M', '-probesize', '200M', '-i', env.INPUT,
            '-filter_complex',
            '[0:a:0]channelsplit=channel_layout=stereo[FL0][FR0];[FL0]aformat=channel_layouts=mono[FL];[FR0]aformat=channel_layouts=mono[FR]',
            '-map', '0:v', '-c:v', 'libx264', '-vf', 'yadif',
            '-map', '[FL]', '-map', '[FR]', '-c:a', 'aac', '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=eng',
            '-map', '0:s?', '-c:s', 'srt', '-preset', 'veryfast', '-crf', '26', env.OUTPUT,
        ]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('decodes only the main language when the audio becomes dual-mono after the probe window', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-'));
    try {
        const argsFile = path.join(dir, 'args');
        const env = writeFakes(dir, `printf '%s\\n' "$@" > '${argsFile}'`, { audioStreams: 1, dualMono: false });

        assert.strictEqual(spawnSync(process.execPath, [encJs, 'cpu'], { env }).status, 0);

        const args = fs.readFileSync(argsFile, 'utf8').trimEnd().split('\n');
        assert.deepStrictEqual(args, [
            '-y', '-fix_sub_duration', '-dual_mono_mode', 'main', '-analyzeduration', '30M', '-probesize', '200M', '-i', env.INPUT,
            '-map', '0:v', '-c:v', 'libx264', '-vf', 'yadif',
            '-map', '0:a', '-c:a', 'aac',
            '-map', '0:s?', '-c:s', 'srt', '-preset', 'veryfast', '-crf', '26', env.OUTPUT,
        ]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('probes 30 s of the input for streams in the stream count and the dual-mono check as well', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-'));
    try {
        const callLog = path.join(dir, 'calls');
        const env = writeFakes(dir, 'exit 0', { audioStreams: 1, dualMono: false, callLog });

        assert.strictEqual(spawnSync(process.execPath, [encJs, 'cpu'], { env }).status, 0);

        const calls = fs.readFileSync(callLog, 'utf8').trimEnd().split('\n');
        const probeCalls = calls.filter(c => c.includes('-select_streams a') || c.includes('-v error -dual_mono_mode'));
        assert.deepStrictEqual(probeCalls.sort(), [
            `ffmpeg -v error -dual_mono_mode main -analyzeduration 30M -probesize 200M -i ${env.INPUT} -map 0:a:0 -t 5 -f s16le -ac 2 -ar 48000 -`,
            `ffmpeg -v error -dual_mono_mode sub -analyzeduration 30M -probesize 200M -i ${env.INPUT} -map 0:a:0 -t 5 -f s16le -ac 2 -ar 48000 -`,
            `ffprobe -v error -analyzeduration 30M -probesize 200M -select_streams a -show_entries stream=index -of json ${env.INPUT}`,
        ]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
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
