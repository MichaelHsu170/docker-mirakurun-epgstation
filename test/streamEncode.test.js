const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFakeTools } = require('./fakeTools.js');

const streamEncodeJs = path.join(__dirname, '..', 'epgstation', 'scripts', 'streamEncode.js');

/**
 * Runs streamEncode.js with the fakes of fakeTools.js (the options in tools) and some TS bytes on its
 * stdin, which is ended when endInput is true. Resolves with the exit code and the arguments that the
 * fake ffmpeg (which exits right away) was given.
 */
const runStreamEncode = async (t, args, tools, endInput = true) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-encode-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const argsFile = path.join(dir, 'args');
    const { ffmpeg } = writeFakeTools(dir, { ffmpegScript: `printf '%s\\n' "$@" > '${argsFile}'`, ...tools });

    const child = spawn(process.execPath, [streamEncodeJs, ...args, ffmpeg], {
        env: { ...process.env, TMPDIR: dir },
    });
    t.after(() => child.kill('SIGKILL'));
    child.stdin.on('error', () => {}); // the script may exit before it reads everything
    child.stdin.write(Buffer.alloc(188 * 100, 0x47));
    if (endInput) {
        child.stdin.end();
    }
    const code = await new Promise(resolve => child.on('exit', resolve));

    return { code, ffmpegArgs: fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trimEnd().split('\n') : null };
};

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

test('exits when ffmpeg exits although the input is still open', { timeout: 10000 }, async t => {
    // two audio streams: the probe window ends after the first ffprobe check, without waiting for the input
    const { code } = await runStreamEncode(t, ['live', 'm2ts', '720p'], { audioStreams: 2 }, false);

    assert.strictEqual(code, 0);
});

test('fails when ffmpeg is killed by a signal', { timeout: 10000 }, async t => {
    const { code } = await runStreamEncode(t, ['live', 'mp4', '720p'], { audioStreams: 2, ffmpegScript: 'kill -9 $$' }, false);

    assert.strictEqual(code, 1);
});

test('builds the ffmpeg arguments of a live profile', { timeout: 10000 }, async t => {
    const { code, ffmpegArgs } = await runStreamEncode(t, ['live', 'm2ts', '720p'], { audioStreams: 2 });

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(ffmpegArgs, [
        '-y', '-re', '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-dual_mono_mode', 'main', '-i', 'pipe:0',
        '-map', '0:v', '-map', '0:a',
        '-sn', '-threads', '0',
        '-c:v', 'h264_nvenc', '-vf', 'yadif_cuda,scale_cuda=-2:720', '-b:v', '3000k',
        '-c:a', 'aac', '-ar', '48000', '-b:a', '192k',
        '-f', 'mpegts', 'pipe:1',
    ]);
});

test('builds the ffmpeg arguments of a recorded profile with dual-mono audio', { timeout: 10000 }, async t => {
    const { code, ffmpegArgs } = await runStreamEncode(t, ['recorded', 'webm', '480p'], { audioStreams: 1, dualMono: true });

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(ffmpegArgs, [
        '-y', '-i', 'pipe:0',
        '-filter_complex',
        '[0:a:0]channelsplit=channel_layout=stereo[FL0][FR0];[FL0]aformat=channel_layouts=mono[FL];[FR0]aformat=channel_layouts=mono[FR]',
        '-map', '0:v', '-map', '[FL]', '-map', '[FR]',
        '-sn', '-threads', '3',
        '-c:v', 'libvpx-vp9', '-vf', 'yadif,scale=-2:480', '-b:v', '1500k', '-deadline', 'realtime', '-speed', '4', '-cpu-used', '-8',
        '-c:a', 'libvorbis', '-ar', '48000', '-b:a', '128k', '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=eng',
        '-f', 'webm', 'pipe:1',
    ]);
});

test('maps any audio when the audio streams cannot be checked', { timeout: 10000 }, async t => {
    const { code, ffmpegArgs } = await runStreamEncode(t, ['live', 'webm', '720p'], { audioStreams: 1, dualMono: 'fail' });

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(ffmpegArgs.slice(0, 9), ['-y', '-re', '-dual_mono_mode', 'main', '-i', 'pipe:0', '-map', '0:v', '-map']);
    assert.strictEqual(ffmpegArgs[9], '0:a?');
});

test('reads no more input while it checks the audio layout, then passes all of it to ffmpeg', { timeout: 30000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-encode-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const countFile = path.join(dir, 'count');
    // each ffprobe call takes 3 s, so the check runs for at least 3 s after the 6 MiB probe window is full
    const { ffmpeg } = writeFakeTools(dir, { audioStreams: 2, probeSeconds: 3, ffmpegScript: `wc -c > '${countFile}'` });

    const child = spawn(process.execPath, [streamEncodeJs, 'recorded', 'mp4', '720p', ffmpeg], {
        env: { ...process.env, TMPDIR: dir },
    });
    t.after(() => child.kill('SIGKILL'));
    const exited = new Promise(resolve => child.on('exit', resolve));

    // a recorded file arrives as fast as the script reads it
    const total = 32 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 0x47);
    let accepted = 0;
    const writing = (async () => {
        while (accepted < total) {
            if (!child.stdin.write(chunk)) {
                await new Promise(resolve => child.stdin.once('drain', resolve));
            }
            accepted += chunk.length;
        }
        child.stdin.end();
    })();

    await new Promise(resolve => setTimeout(resolve, 2000));
    // the 6 MiB probe window plus what the pipe and the stream buffers hold, not all 32 MiB
    assert.ok(accepted < 12 * 1024 * 1024, `accepted ${accepted} bytes during the check`);

    await writing;
    assert.strictEqual(await exited, 0);
    assert.strictEqual(fs.readFileSync(countFile, 'utf8').trim(), String(total));
});

test('refuses an unknown format', { timeout: 10000 }, async t => {
    const { code, ffmpegArgs } = await runStreamEncode(t, ['live', 'avi', '720p'], {});

    assert.strictEqual(code, 1);
    assert.strictEqual(ffmpegArgs, null);
});
