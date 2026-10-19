const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFakeTools } = require('./fakeTools.js');

const root = path.join(__dirname, '..', 'epgstation');
const configYml = path.join(root, 'config', 'config.yml');

// EPGStation's thumbnailCmd when config.yml sets none (srcs/EPGStation/src/model/Configuration.ts)
const DEFAULT_THUMBNAIL_CMD = '%FFMPEG% -ss %THUMBNAIL_POSITION% -y -i %INPUT% -vframes 1 -f image2 -s %THUMBNAIL_SIZE% %OUTPUT%';

/** config.yml's value of a top-level key (a plain or single-quoted scalar), or undefined */
const configValue = key => {
    const line = fs
        .readFileSync(configYml, 'utf8')
        .split('\n')
        .find(l => l.startsWith(`${key}:`));
    return line === undefined ? undefined : line.slice(key.length + 1).trim().replace(/^'(.*)'$/, '$1');
};

/**
 * A fake ffmpeg's thumbnail (the rest of its arguments: [-analyzeduration 30M -probesize 200M] -ss <position> -y -i
 * <input> [-map 0:<stream>] -vframes 1 -f image2 -s <size> <output>), as the real ffmpeg makes it from the video
 * parts (videoFrames of fakeTools.js: [from, to, '<width>,<height>,<sar>', <stream index>]):
 * - with -map 0:<stream>, that stream's frame at the position; without it, the stream ffmpeg selects by default: the
 *   largest picture, of equal ones the lowest index (review D21-1: BS日テレ 142's own 720x480 stream 9 lost to the
 *   main channel's 1440x1080 lead-in stream 0);
 * - without -probesize (the default 5 MB probe) a stream that starts 2 s or more in (a stream that a later PMT adds,
 *   fakeTools.js) is "unsupported type": -map of it fails ("Cannot map stream", exit 234) and the default selection
 *   skips it;
 * - when the position is past the end of the recording (of every part), it writes the selected stream's last frame
 *   and exits 0: the real ffmpeg goes back to the last keyframe and, when the recording ends inside that I-frame,
 *   writes the cut-off frame, garbled (review S22-2: about 1 in 6 cuts of real GR, BS and CS recordings; at the
 *   other cuts it writes nothing and exits 234, as below);
 * - when the selected stream has no frame at the position otherwise, it writes nothing and exits 234 (review D21-1's
 *   1-h 142 recording; on a 3-min 142 capture ffmpeg instead wrote the lead-in's last frame, half-decoded, and exited
 *   0: either way not the program's picture).
 * The output holds the index of the stream the picture is from and the -ss position, or "cut-off" for the cut-off last
 * frame past the end.
 */
const thumbnailFfmpeg = videoFrames => {
    const parts = videoFrames.map(([from, to, size, index = 0]) => `${index} ${from} ${to} ${size.split(',').slice(0, 2).join(' ')}`).join('\\n');
    return (
        'ss=; map=; ps=; out=; prev=; for a; do [ "$prev" = -ss ] && ss="$a"; [ "$prev" = -map ] && map="${a#0:}"; ' +
        '[ "$a" = -probesize ] && ps=1; prev="$a"; out="$a"; done\n' +
        `stream=$(printf '${parts}\\n' | awk -v ss="$ss" -v map="$map" -v ps="$ps" '` +
        '{ i = $1; if (!(i in first) || $2 < first[i]) first[i] = $2; area[i] = $4 * $5; n++; f[n] = $1; s[n] = $2; e[n] = $3 } ' +
        'END { for (i in first) found[i] = (ps != "" || first[i] < 2); ' +
        '  if (map != "") { if (!(map in found) || !found[map]) exit 234; sel = map } ' +
        '  else { sel = ""; for (i in found) if (found[i] && (sel == "" || area[i] > area[sel] || (area[i] == area[sel] && i + 0 < sel + 0))) sel = i } ' +
        '  end = 0; for (k = 1; k <= n; k++) { if (e[k] > end) end = e[k]; if (f[k] == sel && s[k] <= ss && ss < e[k]) { print sel, ss; exit 0 } } ' +
        '  if (ss >= end) { print sel, "cut-off"; exit 0 } ' +
        "  exit 234 }') || exit $?\n" +
        'printf "%s" "$stream" > "$out"'
    );
};

/**
 * Runs config.yml's thumbnailCmd as EPGStation does (ThumbnailManageModel.create: %FFMPEG% replaced in the whole
 * command, then %NODE% and %ROOT% (ProcessUtil.parseCmdStr) and the other placeholders in each argument) with
 * config.yml's thumbnailPosition and thumbnailSize, on a recording whose video is videoFrames, with the fakes of
 * fakeTools.js (other options in tools; the recording's duration is their inputDuration, 100 s by default). Returns
 * the exit status, the index of the stream the thumbnail is from (null when none was written) and its position in the
 * recording (the -ss position, or 'cut-off' for the cut-off last frame past the end). With slowClock,
 * node runs every timer of the script 1000 times sooner (thumbnail.js's 9-min limit in 0.54 s), the fake ffprobe and
 * ffmpeg write their process IDs to the files ffprobe.pid and ffmpeg.pid, and also returned are the IDs of those
 * still running when the script has exited.
 */
const runThumbnail = (videoFrames, tools = {}, ffmpegScript = thumbnailFfmpeg(videoFrames), slowClock = false) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-test-'));
    try {
        const pidFile = name => path.join(dir, `${name}.pid`);
        const { ffmpeg, ffprobe } = writeFakeTools(dir, {
            videoFrames,
            ffmpegScript: slowClock ? `echo $$ >> '${pidFile('ffmpeg')}'\n${ffmpegScript}` : ffmpegScript,
            ...tools,
        });
        const env = { ...process.env };
        if (slowClock) {
            // the fake ffprobe, with its process ID (exec keeps it)
            fs.renameSync(ffprobe, `${ffprobe}.fake`);
            fs.writeFileSync(ffprobe, `#!/bin/sh\necho $$ >> '${pidFile('ffprobe')}'\nexec '${ffprobe}.fake' "$@"\n`, { mode: 0o755 });
            const clock = path.join(dir, 'clock.js');
            fs.writeFileSync(clock, 'const t = setTimeout;\nglobal.setTimeout = (f, ms, ...a) => t(f, ms / 1000, ...a);\n');
            env.NODE_OPTIONS = `--require ${clock}`;
        }
        const input = path.join(dir, 'in.m2ts');
        const output = path.join(dir, 'out.jpg');
        const [bin, ...args] = (configValue('thumbnailCmd') || DEFAULT_THUMBNAIL_CMD).replace(/%FFMPEG%/g, ffmpeg).split(' ');
        const result = spawnSync(
            bin.replace(/%NODE%/g, process.execPath),
            args.map(arg =>
                arg
                    .replace(/%ROOT%/g, root)
                    .replace(/%INPUT%/, input)
                    .replace(/%OUTPUT%/, output)
                    .replace(/%THUMBNAIL_POSITION%/, configValue('thumbnailPosition'))
                    .replace(/%THUMBNAIL_SIZE%/, configValue('thumbnailSize')),
            ),
            { env },
        );
        const [stream, at] = fs.existsSync(output) ? fs.readFileSync(output, 'utf8').split(' ') : [null, null];
        const thumbnail = { status: result.status, stream: stream === null ? null : Number(stream), at };
        if (!slowClock) {
            return thumbnail;
        }
        const running = name =>
            (fs.existsSync(pidFile(name)) ? fs.readFileSync(pidFile(name), 'utf8').trim().split('\n') : []).filter(pid => {
                try {
                    process.kill(Number(pid), 0);
                    return true;
                } catch (err) {
                    return false;
                }
            });
        return { ...thumbnail, ffprobes: running('ffprobe'), ffmpegs: running('ffmpeg'), ranFfmpeg: fs.existsSync(pidFile('ffmpeg')) };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

test('the thumbnail of a recording is taken from its video', () => {
    assert.deepStrictEqual(runThumbnail([[0, 1e9, '1440,1080,4:3', 1]]), { status: 0, stream: 1, at: '60' });
    assert.deepStrictEqual(runThumbnail([[0, 1e9, '720,480,32:27', 1]]), { status: 0, stream: 1, at: '60' });
});

test("a sub-channel program's recording gets its thumbnail from the program's own video, not the main channel's lead-in", () => {
    // review D21-1: BS日テレ 142's own SD program after a simulcast on 141's HD PIDs (lead-in 5 s); Mirakurun stops
    // the main channel's PIDs at the switch
    assert.deepStrictEqual(runThumbnail([[0, 5, '1440,1080,4:3', 0], [5, 1e9, '720,480,32:27', 9]]), { status: 0, stream: 9, at: '60' });
    // the same picture size on both (NHK BS 102 in HD): the default selection takes the lower index, the lead-in's
    assert.deepStrictEqual(runThumbnail([[0, 5, '1440,1080,4:3', 0], [5, 1e9, '1440,1080,4:3', 9]]), { status: 0, stream: 9, at: '60' });
});

test('a recording shorter than the thumbnail position + 1 s gets its thumbnail from its middle, not a garbled last frame', () => {
    // review S22-2: at the position (60 s) a 42-s recording got its last, cut-off I-frame; the owner chose the middle
    // frame for these (a frame 1 s or more before the end is whole: real GR, BS and CS cuts of 2-60.5 s)
    assert.deepStrictEqual(runThumbnail([[0, 30, '1440,1080,4:3', 1]], { inputDuration: '30' }), { status: 0, stream: 1, at: '15' });
    assert.deepStrictEqual(runThumbnail([[0, 60.5, '1440,1080,4:3', 1]], { inputDuration: '60.5' }), { status: 0, stream: 1, at: '30.25' });
    assert.deepStrictEqual(runThumbnail([[0, 61, '1440,1080,4:3', 1]], { inputDuration: '61' }), { status: 0, stream: 1, at: '60' });
    // the shortest with a middle 1 s before the end
    assert.deepStrictEqual(runThumbnail([[0, 2, '1440,1080,4:3', 1]], { inputDuration: '2' }), { status: 0, stream: 1, at: '1' });
    const tooShort = runThumbnail([[0, 1.9, '1440,1080,4:3', 1]], { inputDuration: '1.9' });
    assert.notStrictEqual(tooShort.status, 0);
    assert.strictEqual(tooShort.stream, null);
});

test("a short sub-channel recording gets the program's own picture when its middle is past the lead-in, the main channel's when it is all lead-in", () => {
    // the main channel's HD lead-in on stream 0 until the switch, then the program's own SD video on stream 9;
    // ffprobe's programs may still list the lead-in's video (review D22-2: BS日テレ 142)
    assert.deepStrictEqual(runThumbnail([[0, 12, '1440,1080,4:3', 0], [12, 40, '720,480,32:27', 9]], { inputDuration: '40' }), {
        status: 0,
        stream: 9,
        at: '20',
    });
    // a lead-in under 5 s: the last 5 s of the recording still hold the lead-in's video, which has no frame at the middle
    assert.deepStrictEqual(runThumbnail([[0, 4, '1440,1080,4:3', 0], [4, 8.5, '720,480,32:27', 9]], { inputDuration: '8.5' }), {
        status: 0,
        stream: 9,
        at: '4.25',
    });
    // no program video yet: the main channel's picture, as any recording whose middle is in its lead-in
    assert.deepStrictEqual(runThumbnail([[0, 8, '1440,1080,4:3', 0]], { inputDuration: '8' }), { status: 0, stream: 0, at: '4' });
});

test('a recording of unknown duration gets its thumbnail at the position', () => {
    // review D23-1: a sub-channel recording whose broadcast clock wrapped after the switch has no duration
    assert.deepStrictEqual(runThumbnail([[0, 1e9, '1440,1080,4:3', 1]], { inputDuration: 'N/A' }), { status: 0, stream: 1, at: '60' });
});

test('a thumbnail whose ffmpeg does not finish is stopped with its ffmpeg before EPGStation kills the script', () => {
    // review S22-1: EPGStation SIGKILLs only the script (after 10 min); its ffmpeg kept running and wrote the
    // thumbnail later. The fake ffmpeg would write its thumbnail after 5 s, far past the (sped-up) 9-min limit
    const frames = [[0, 1e9, '1440,1080,4:3', 1]];
    const result = runThumbnail(frames, {}, `sleep 5 > /dev/null 2>&1\n${thumbnailFfmpeg(frames)}`, true);
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(result.stream, null);
    assert.strictEqual(result.ranFfmpeg, true);
    assert.deepStrictEqual(result.ffmpegs, []);
});

test('a thumbnail whose ffprobe does not finish is stopped with its ffprobe, and no ffmpeg is started', () => {
    // the fake ffprobe would answer after 2 s
    const result = runThumbnail([[0, 1e9, '1440,1080,4:3', 1]], { probeSeconds: 2 }, undefined, true);
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(result.stream, null);
    assert.deepStrictEqual(result.ffprobes, []);
    assert.strictEqual(result.ranFfmpeg, false);
});

test("without the program's video 60 s in, the thumbnail is taken as EPGStation's default command takes it", () => {
    // no frame whose SAR is known in the 60 s window (programVideoSize finds nothing), and a failed probe
    assert.deepStrictEqual(runThumbnail([[0, 1e9, '1440,1080,N/A', 1]]), { status: 0, stream: 1, at: '60' });
    const frames = [[0, 1e9, '1440,1080,4:3', 1]];
    assert.deepStrictEqual(runThumbnail('fail', {}, thumbnailFfmpeg(frames)), { status: 0, stream: 1, at: '60' });
});

test('the exit status is non-zero when ffmpeg fails or is killed, so EPGStation registers no thumbnail', () => {
    assert.strictEqual(runThumbnail([[0, 1e9, '1440,1080,4:3', 1]], {}, 'exit 3').status, 3);
    // EPGStation counts any code but 0 as a failure (a signal: null)
    assert.notStrictEqual(runThumbnail([[0, 1e9, '1440,1080,4:3', 1]], {}, 'kill -9 $$').status, 0);
});
