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

test('reports progress from the lines of ffmpeg 9 with the caption input\'s video, which adds its own q', () => {
    // two lines of a real run (enc.js gpu, テレ東 09:15): the null output's video copy adds q=-1.0, and Lq=-1.0 on the last line
    const result = runEncResult(
        "printf '%s\\r' 'frame= 7976 fps=431 q=21.0 q=-1.0 size=   66304KiB time=00:04:27.73 bitrate=2028.8kbits/s speed=14.5x elapsed=0:00:18.50    ' >&2; " +
            "printf '%s\\n' 'frame= 8211 fps=432 q=23.0 Lq=-1.0 size=   69183KiB time=00:04:34.70 bitrate=2063.1kbits/s speed=14.4x elapsed=0:00:19.01' >&2",
        { inputDuration: '549.4', outputDuration: '549.4' },
    );

    const progress = progressOf(result);
    assert.deepStrictEqual(
        progress.map(p => p.log.match(/time=\S+/)[0]),
        ['time=00:04:27.73', 'time=00:04:34.70'],
    );
    assert.strictEqual(progress[1].percent, 0.5);
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
        // only the 1st input (video and audio) is read at most 12x real time, not the caption input
        assert.deepStrictEqual(args, [
            '-y', '-readrate', '12', '-analyzeduration', '30M', '-probesize', '200M', '-i', env.INPUT,
            '-fix_sub_duration', '-isync', '0', '-analyzeduration', '30M', '-probesize', '200M', '-i', env.INPUT,
            '-filter_complex',
            '[0:a:0]channelsplit=channel_layout=stereo[FL0][FR0];[FL0]aformat=channel_layouts=mono[FL];[FR0]aformat=channel_layouts=mono[FR]',
            '-map', '0:0', '-c:v', 'libx264', '-vf', 'yadif,scale=1440:1080,setsar=4/3',
            '-map', '[FL]', '-map', '[FR]', '-c:a', 'aac', '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=eng',
            '-map', '1:s?', '-c:s', 'srt', '-preset', 'veryfast', '-crf', '26', env.OUTPUT,
            '-map', '1:v', '-c', 'copy', '-f', 'null', '-',
        ]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('splits a dual-mono recording that starts with 19.2 s of the previous program\'s stereo', () => {
    // History 06:00 (review D12-1): the program's dual mono starts 19.2 s into its recording
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-'));
    try {
        const argsFile = path.join(dir, 'args');
        const env = writeFakes(dir, `printf '%s\\n' "$@" > '${argsFile}'`, {
            audioStreams: 1,
            dualMono: [[19.2, false], [231.8, true]],
            inputDuration: '251',
            outputDuration: '251',
            outputAudioDuration: '00:04:11.000000000',
        });

        assert.strictEqual(spawnSync(process.execPath, [encJs, 'cpu'], { env }).status, 0);

        const args = fs.readFileSync(argsFile, 'utf8').trimEnd().split('\n');
        assert.deepStrictEqual(args.slice(args.indexOf('-filter_complex'), args.indexOf('-filter_complex') + 2), [
            '-filter_complex',
            '[0:a:0]channelsplit=channel_layout=stereo[FL0][FR0];[FL0]aformat=channel_layouts=mono[FL];[FR0]aformat=channel_layouts=mono[FR]',
        ]);
        assert.strictEqual(args.includes('-dual_mono_mode'), false);
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
            '-y', '-dual_mono_mode', 'main', '-readrate', '12', '-analyzeduration', '30M', '-probesize', '200M', '-i', env.INPUT,
            '-fix_sub_duration', '-isync', '0', '-analyzeduration', '30M', '-probesize', '200M', '-i', env.INPUT,
            '-map', '0:0', '-c:v', 'libx264', '-vf', 'yadif,scale=1440:1080,setsar=4/3',
            '-map', '0:a', '-c:a', 'aac',
            '-map', '1:s?', '-c:s', 'srt', '-preset', 'veryfast', '-crf', '26', env.OUTPUT,
            '-map', '1:v', '-c', 'copy', '-f', 'null', '-',
        ]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('probes 30 s of the input for streams in the stream count and the dual-mono check, which decodes from 60 s in', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-'));
    try {
        const callLog = path.join(dir, 'calls');
        const env = writeFakes(dir, 'exit 0', { audioStreams: 1, dualMono: false, callLog });

        assert.strictEqual(spawnSync(process.execPath, [encJs, 'cpu'], { env }).status, 0);

        const calls = fs.readFileSync(callLog, 'utf8').trimEnd().split('\n');
        const probeCalls = calls.filter(c => c.includes('-select_streams a ') || c.includes('-v error -dual_mono_mode'));
        assert.deepStrictEqual(probeCalls.sort(), [
            `ffmpeg -v error -dual_mono_mode main -analyzeduration 30M -probesize 200M -ss 60 -i ${env.INPUT} -map 0:a:0 -t 5 -f s16le -`,
            `ffmpeg -v error -dual_mono_mode sub -analyzeduration 30M -probesize 200M -ss 60 -i ${env.INPUT} -map 0:a:0 -t 5 -f s16le -`,
            `ffprobe -v error -analyzeduration 30M -probesize 200M -select_streams a -show_entries stream=index -of json ${env.INPUT}`,
        ]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('encodes only the program\'s audio stream when a 2nd one is only in the lead-in', () => {
    // テレ東 09:15 (review D13-1): the previous program's 2nd audio stream has packets until 5.16 s of 275 s
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-'));
    try {
        const argsFile = path.join(dir, 'args');
        const env = writeFakes(dir, `printf '%s\\n' "$@" > '${argsFile}'`, {
            audioStreams: 2,
            audioPackets: [[0, 274.8], [0, 5.16]],
            inputDuration: '274.791789',
            outputDuration: '274.8',
            outputAudioDuration: '00:04:34.325000000',
        });

        assert.strictEqual(spawnSync(process.execPath, [encJs, 'cpu'], { env }).status, 0);

        const args = fs.readFileSync(argsFile, 'utf8').trimEnd().split('\n');
        assert.deepStrictEqual(args.slice(args.indexOf('-vf') + 2, args.indexOf('1:s?') - 1), ['-map', '0:a:0', '-c:a', 'aac']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('fails when the first audio track of the output ends more than 5 s before the output', () => {
    // recorded.id 2205 (review D13-3): 8.426 s of audio in a 3545.742 s output
    const result = runEncResult('exit 0', {
        audioStreams: 1,
        inputDuration: '3546.1',
        outputDuration: '3545.742',
        outputAudioDuration: '00:00:08.426000000',
    });

    assert.strictEqual(result.status, 1);
    assert.match(
        String(result.stderr),
        /^enc\.js: the first audio track is 8\.426s, the output is 3545\.742s: treating the encode as failed$/m,
    );
    assert.strictEqual(runEnc('exit 0', { audioStreams: 1, outputAudioDuration: '00:01:34.900000000' }), 1);
});

test('exits 0 when the first audio track of the output ends at most 5 s before the output', () => {
    assert.strictEqual(runEnc('exit 0', { audioStreams: 1, outputAudioDuration: '00:01:35.000000000' }), 0);
    // recorded.id 2211, the largest difference of the 40 complete encodes (0.388 s)
    assert.strictEqual(
        runEnc('exit 0', { audioStreams: 1, inputDuration: '3591', outputDuration: '3590.787', outputAudioDuration: '00:59:50.399000000' }),
        0,
    );
    // 1 h of audio
    assert.strictEqual(
        runEnc('exit 0', { audioStreams: 1, inputDuration: '3600', outputDuration: '3600.2', outputAudioDuration: '01:00:00.000000000' }),
        0,
    );
});

test('compares the audio with the output, which ffmpeg shortened by the closed-up gaps as well', () => {
    const tools = { audioStreams: 1, inputDuration: '79.342066', outputDuration: '69.169' };
    assert.strictEqual(runEnc(`${discontinuities(-10176000)}exit 0`, { ...tools, outputAudioDuration: '00:01:09.100000000' }), 0);
    assert.strictEqual(runEnc(`${discontinuities(-10176000)}exit 0`, { ...tools, outputAudioDuration: '00:01:04.000000000' }), 1);
});

/**
 * A fake ffmpeg (sh) for a recording whose only caption is the previous program's, in its first seconds (NHK's
 * caption-less programs, review D14-1). It writes the output's audio length as ffmpeg 9 makes it: -fix_sub_duration
 * holds that caption until the input ends, and while it is held ffmpeg 9 stops the other streams of the input the
 * caption comes from, so when that input is also the audio's (input 0) the output gets 0.063 s of audio (production:
 * 0.063-0.191 s; or ffmpeg reads the whole recording into memory first). From an input of its own, the caption holds
 * up only that input, and the audio is complete (60 min).
 */
const leadInCaptionOnly =
    'n=0; fix=; sub=; next=; prev=\n' +
    'for a; do\n' +
    '  [ "$a" = -fix_sub_duration ] && next=1\n' +
    '  if [ "$prev" = -i ]; then [ -n "$next" ] && fix=$n; next=; n=$((n + 1)); fi\n' +
    '  case "$prev $a" in "-map "*:s*) sub=${a%%:*};; esac\n' +
    '  prev=$a\n' +
    'done\n' +
    'if [ "$fix" = 0 ] && [ "$sub" = 0 ]; then a=00:00:00.063000000; else a=01:00:00.000000000; fi\n' +
    'printf %s "$a" > "$OUTPUT"';

test('encodes a recording whose only caption is the previous program\'s with all its audio', () => {
    // recorded.id 2203 (review D14-1): 60 min, one caption at 5 s
    const result = runEncResult(leadInCaptionOnly, { audioStreams: 1, inputDuration: '3600.597', outputDuration: '3600.597' });

    assert.strictEqual(result.status, 0, String(result.stderr));
    assert.doesNotMatch(String(result.stderr), /^enc\.js: the first audio track/m);
});

test('fails when the audio duration of the output cannot be read', () => {
    assert.strictEqual(runEnc('exit 0', { audioStreams: 1, outputAudioDuration: 'N/A' }), 1);
});

test('does not check the audio of an output without audio', () => {
    // the fake output has no audio stream either: reading its audio duration would fail
    assert.strictEqual(runEnc('exit 0', { audioStreams: 0 }), 0);
});

test('probes 30 s of the input for streams in the probe for the program\'s audio streams, 60 s in', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-'));
    try {
        const callLog = path.join(dir, 'calls');
        const env = writeFakes(dir, 'exit 0', { audioStreams: 2, callLog });

        assert.strictEqual(spawnSync(process.execPath, [encJs, 'cpu'], { env }).status, 0);

        const calls = fs.readFileSync(callLog, 'utf8').trimEnd().split('\n');
        assert.deepStrictEqual(calls.filter(c => c.includes('-read_intervals') && c.includes('-select_streams a ')), [
            `ffprobe -v error -analyzeduration 30M -probesize 200M -read_intervals +60%+5 -select_streams a -show_entries packet=stream_index:program_stream=index -of json ${env.INPUT}`,
        ]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * Runs enc.js in the given mode (gpu or cpu) with the fakes of writeFakes (tools) and an ffmpeg that records its
 * arguments. Returns enc.js's exit code and ffmpeg's arguments (null when ffmpeg did not run).
 */
const ffmpegArgsOf = (mode, tools) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-'));
    try {
        const argsFile = path.join(dir, 'args');
        const env = writeFakes(dir, `printf '%s\\n' "$@" > '${argsFile}'`, tools);
        const status = spawnSync(process.execPath, [encJs, mode], { env }).status;

        return { status, args: fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trimEnd().split('\n') : null };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

/** Like ffmpegArgsOf, with the value of ffmpeg's -vf (null when ffmpeg did not run) instead of its arguments */
const videoFilterOf = (mode, tools) => {
    const { status, args } = ffmpegArgsOf(mode, tools);

    return { status, vf: args === null ? null : args[args.indexOf('-vf') + 1] };
};

// a recording of a program in 480i (720x480, SAR 32:27) that starts with 15 s of the previous program in 1080i
// (1440x1080, SAR 4:3), as on NHK BS 102 or tvk2 (review D17-1), and the other way round
const HD_LEAD_IN = [[0, 15, '1440,1080,4:3'], [15, 1e9, '720,480,32:27']];
const SD_LEAD_IN = [[0, 15, '720,480,32:27'], [15, 1e9, '1440,1080,4:3']];

test('scales the GPU encode to the program\'s size and SAR when the lead-in has another size', () => {
    assert.deepStrictEqual(videoFilterOf('gpu', { videoFrames: HD_LEAD_IN }), {
        status: 0,
        vf: 'yadif_cuda,hwdownload,format=nv12,scale=720:480,setsar=32/27',
    });
    assert.deepStrictEqual(videoFilterOf('gpu', { videoFrames: SD_LEAD_IN }), {
        status: 0,
        vf: 'yadif_cuda,hwdownload,format=nv12,scale=1440:1080,setsar=4/3',
    });
});

test('scales the CPU encode to the program\'s size and SAR when the lead-in has another size', () => {
    assert.deepStrictEqual(videoFilterOf('cpu', { videoFrames: HD_LEAD_IN }), { status: 0, vf: 'yadif,scale=720:480,setsar=32/27' });
    assert.deepStrictEqual(videoFilterOf('cpu', { videoFrames: SD_LEAD_IN }), { status: 0, vf: 'yadif,scale=1440:1080,setsar=4/3' });
});

test('takes the program\'s size from the last 5 s of a recording shorter than 65 s', () => {
    // 40 s: the program's size from 35 s in, past the 15 s lead-in
    const tools = { inputDuration: '40', outputDuration: '40', videoFrames: HD_LEAD_IN };
    assert.deepStrictEqual(videoFilterOf('cpu', tools), { status: 0, vf: 'yadif,scale=720:480,setsar=32/27' });
});

test('takes the size from the start of a recording of unknown duration', () => {
    assert.deepStrictEqual(videoFilterOf('cpu', { inputDuration: 'N/A', videoFrames: HD_LEAD_IN }), {
        status: 0,
        vf: 'yadif,scale=1440:1080,setsar=4/3',
    });
});

test('takes the program\'s size from the 5 s from 60 s in', () => {
    // a lead-in longer than the 5-19 s seen so far: the size from 60 s in, not from 55 s in
    assert.deepStrictEqual(videoFilterOf('cpu', { videoFrames: [[0, 59.9, '1440,1080,4:3'], [59.9, 1e9, '720,480,32:27']] }), {
        status: 0,
        vf: 'yadif,scale=720:480,setsar=32/27',
    });
    // the 5 s window ends at 65 s
    assert.deepStrictEqual(videoFilterOf('cpu', { videoFrames: [[0, 65, '1440,1080,4:3'], [65, 1e9, '720,480,32:27']] }), {
        status: 0,
        vf: 'yadif,scale=1440:1080,setsar=4/3',
    });
});

test('takes the size of the first frame whose SAR is known', () => {
    assert.deepStrictEqual(
        videoFilterOf('cpu', { videoFrames: [[60, 61, '1920,1080,N/A'], [61, 1e9, '1440,1080,4:3']] }),
        { status: 0, vf: 'yadif,scale=1440:1080,setsar=4/3' },
    );
});

test('deinterlaces without scaling when no video frame is found where the program\'s size is looked for', () => {
    assert.deepStrictEqual(videoFilterOf('gpu', { videoFrames: [] }), { status: 0, vf: 'yadif_cuda' });
    assert.deepStrictEqual(videoFilterOf('cpu', { videoFrames: [[0, 10, '720,480,32:27']] }), { status: 0, vf: 'yadif' });
});

test('fails without encoding when the probe for the program\'s size fails', () => {
    // the TS is kept
    assert.deepStrictEqual(videoFilterOf('gpu', { videoFrames: 'fail' }), { status: 1, vf: null });
});

/** ffmpeg's video and audio -map arguments, its -vf, and enc.js's exit code */
const mapsOf = (mode, tools) => {
    const { status, args } = ffmpegArgsOf(mode, tools);
    const maps = args.flatMap((arg, i) => (arg === '-map' && args[i + 1].startsWith('0:') ? [args[i + 1]] : []));

    return { status, maps, vf: args[args.indexOf('-vf') + 1] };
};

// NHK BS 102's MLB at 09:00 after a simulcast slot with NHK BS 101 (review D18-1): the recording starts with 5.5 s
// of the main channel's 1080i video (stream 0) and audio (stream 1), then the sub-channel's own 480i video (30) and
// audio (11); from then on the PMT lists only the sub-channel's own streams
// The output starts with the sub-channel's own streams: it is shorter than the recording by the lead-in.
const SUB_CHANNEL = {
    audioStreams: 2,
    inputDuration: '300',
    outputDuration: '294.5',
    outputAudioDuration: '00:04:54.500000000',
};

test('encodes only the sub-channel program\'s video and audio when the main channel\'s run to the end of the recording', () => {
    // recorded while Mirakurun passed every PID the PMT ever listed: the main channel's streams have packets throughout
    const tools = {
        ...SUB_CHANNEL,
        videoFrames: [[0, 1e9, '1440,1080,4:3', 0], [5.5, 1e9, '720,480,32:27', 30]],
        audioPackets: [[0, 1e9], [5.5, 1e9]],
        pmtStreams: [11, 30],
    };
    assert.deepStrictEqual(mapsOf('cpu', tools), { status: 0, maps: ['0:30', '0:a:1'], vf: 'yadif,scale=720:480,setsar=32/27' });
    assert.deepStrictEqual(mapsOf('gpu', tools), {
        status: 0,
        maps: ['0:30', '0:a:1'],
        vf: 'yadif_cuda,hwdownload,format=nv12,scale=720:480,setsar=32/27',
    });
});

test('leaves out a video stream that is only in the lead-in', () => {
    // the main channel's streams stop at the switch; no PMT read (pmtStreams lists nothing): the 60 s window decides
    const tools = {
        ...SUB_CHANNEL,
        videoFrames: [[0, 5.5, '1440,1080,4:3', 0], [5.5, 1e9, '720,480,32:27', 30]],
        audioPackets: [[0, 5.5], [5.5, 1e9]],
        pmtStreams: [],
    };
    assert.deepStrictEqual(mapsOf('cpu', tools), { status: 0, maps: ['0:30', '0:a:1'], vf: 'yadif,scale=720:480,setsar=32/27' });
});

test('encodes only the captions that the program\'s PMT lists', () => {
    // the main channel's captions (stream 3) run to the end of a recording made before the Mirakurun fix, or end with
    // the lead-in after it; the sub-channel's own are stream 33
    const { status, args } = ffmpegArgsOf('cpu', {
        ...SUB_CHANNEL,
        videoFrames: [[0, 5.5, '1440,1080,4:3', 0], [5.5, 1e9, '720,480,32:27', 30]],
        audioPackets: [[0, 5.5], [5.5, 1e9]],
        subtitleStreams: [3, 33],
        pmtStreams: [11, 30, 33],
    });
    assert.strictEqual(status, 0);
    assert.deepStrictEqual(args.slice(args.indexOf('-c:s') - 2, args.indexOf('-c:s')), ['-map', '1:33']);
});

test('encodes every caption stream when the PMT lists none', () => {
    const { status, args } = ffmpegArgsOf('cpu', { subtitleStreams: [3], pmtStreams: [0, 1] });
    assert.strictEqual(status, 0);
    assert.deepStrictEqual(args.slice(args.indexOf('-c:s') - 2, args.indexOf('-c:s')), ['-map', '1:s?']);
});

test('fails the encode of a sub-channel program when more than 5 s of the program are missing', () => {
    // the 5.5 s lead-in of the main channel is not encoded; 6 s more are missing
    const tools = {
        ...SUB_CHANNEL,
        outputDuration: '288.5',
        outputAudioDuration: '00:04:48.500000000',
        videoFrames: [[0, 5.5, '1440,1080,4:3', 0], [5.5, 1e9, '720,480,32:27', 30]],
        audioPackets: [[0, 5.5], [5.5, 1e9]],
    };
    assert.strictEqual(runEnc('exit 0', tools), 1);
    assert.strictEqual(runEnc('exit 0', { ...tools, outputDuration: '289.5', outputAudioDuration: '00:04:49.500000000' }), 0);
});

test('allows no lead-in when the previous program\'s video is on the program\'s own video stream', () => {
    // one video stream, from 3 s in (after the first audio), changing size at 15 s: the whole recording is encoded
    const videoFrames = [[3, 15, '1440,1080,4:3'], [15, 1e9, '720,480,32:27']];
    assert.strictEqual(runEnc('exit 0', { inputDuration: '300', outputDuration: '294.5', videoFrames }), 1);
});

test('encodes every video stream that the program has', () => {
    // two video streams in the PMT with frames 60 s in (e.g. a multi-view program): both, the size from the first
    const tools = { videoFrames: [[0, 1e9, '1920,1080,1:1', 0], [0, 1e9, '1440,1080,4:3', 30]] };
    assert.deepStrictEqual(mapsOf('cpu', tools), { status: 0, maps: ['0:0', '0:30'], vf: 'yadif,scale=1920:1080,setsar=1/1' });
});

test('maps every video stream when no video frame is found where the program\'s video is looked for', () => {
    assert.deepStrictEqual(mapsOf('cpu', { videoFrames: [] }), { status: 0, maps: ['0:v'], vf: 'yadif' });
});

test('checks the output duration of a recording whose duration the default probe cannot tell', () => {
    // the sub-channel's own streams start after the default probe's 5 MB: its duration is N/A (review D18-1)
    assert.strictEqual(runEnc('exit 0', { inputDuration: '300', defaultProbeDuration: 'N/A', outputDuration: '100' }), 1);
    assert.strictEqual(runEnc('exit 0', { inputDuration: '300', defaultProbeDuration: 'N/A', outputDuration: '300' }), 0);
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
