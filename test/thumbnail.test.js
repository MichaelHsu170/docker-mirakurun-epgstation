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
 * - without -probesize (the default 5 MB probe: about 2 s of BS) a stream that starts later is "unsupported type":
 *   -map of it fails with exit 1 and the default selection skips it;
 * - when the selected stream has no frame at the position, it writes nothing and exits 234 (review D21-1's 1-h 142
 *   recording; on a 3-min 142 capture ffmpeg instead wrote the lead-in's last frame, half-decoded, and exited 0:
 *   either way not the program's picture).
 * The output holds the index of the stream the picture is from.
 */
const thumbnailFfmpeg = videoFrames => {
    const parts = videoFrames.map(([from, to, size, index = 0]) => `${index} ${from} ${to} ${size.split(',').slice(0, 2).join(' ')}`).join('\\n');
    return (
        'ss=; map=; ps=; out=; prev=; for a; do [ "$prev" = -ss ] && ss="$a"; [ "$prev" = -map ] && map="${a#0:}"; ' +
        '[ "$a" = -probesize ] && ps=1; prev="$a"; out="$a"; done\n' +
        `stream=$(printf '${parts}\\n' | awk -v ss="$ss" -v map="$map" -v ps="$ps" '` +
        '{ i = $1; if (!(i in first) || $2 < first[i]) first[i] = $2; area[i] = $4 * $5; n++; f[n] = $1; s[n] = $2; e[n] = $3 } ' +
        'END { for (i in first) found[i] = (ps != "" || first[i] < 2); ' +
        '  if (map != "") { if (!(map in found) || !found[map]) exit 1; sel = map } ' +
        '  else { sel = ""; for (i in found) if (found[i] && (sel == "" || area[i] > area[sel] || (area[i] == area[sel] && i + 0 < sel + 0))) sel = i } ' +
        '  for (k = 1; k <= n; k++) if (f[k] == sel && s[k] <= ss && ss < e[k]) { print sel; exit 0 } ' +
        "  exit 234 }') || exit $?\n" +
        'printf "%s" "$stream" > "$out"'
    );
};

/**
 * Runs config.yml's thumbnailCmd as EPGStation does (ThumbnailManageModel.create: %FFMPEG% replaced in the whole
 * command, then %NODE% and %ROOT% (ProcessUtil.parseCmdStr) and the other placeholders in each argument) with
 * config.yml's thumbnailPosition and thumbnailSize, on a recording whose video is videoFrames, with the fakes of
 * fakeTools.js (other options in tools). Returns the exit status and the index of the stream the thumbnail is from
 * (null when none was written).
 */
const runThumbnail = (videoFrames, tools = {}, ffmpegScript = thumbnailFfmpeg(videoFrames)) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-test-'));
    try {
        const { ffmpeg } = writeFakeTools(dir, { videoFrames, ffmpegScript, ...tools });
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
        );
        return { status: result.status, stream: fs.existsSync(output) ? Number(fs.readFileSync(output, 'utf8')) : null };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

test('the thumbnail of a recording is taken from its video', () => {
    assert.deepStrictEqual(runThumbnail([[0, 1e9, '1440,1080,4:3', 1]]), { status: 0, stream: 1 });
    assert.deepStrictEqual(runThumbnail([[0, 1e9, '720,480,32:27', 1]]), { status: 0, stream: 1 });
});

test("a sub-channel program's recording gets its thumbnail from the program's own video, not the main channel's lead-in", () => {
    // review D21-1: BS日テレ 142's own SD program after a simulcast on 141's HD PIDs (lead-in 5 s); its PMT lists
    // only its own streams, and Mirakurun stops the main channel's PIDs at the switch
    const pmtStreams = [9, 10];
    assert.deepStrictEqual(runThumbnail([[0, 5, '1440,1080,4:3', 0], [5, 1e9, '720,480,32:27', 9]], { pmtStreams }), {
        status: 0,
        stream: 9,
    });
    // the same picture size on both (NHK BS 102 in HD): the default selection takes the lower index, the lead-in's
    assert.deepStrictEqual(runThumbnail([[0, 5, '1440,1080,4:3', 0], [5, 1e9, '1440,1080,4:3', 9]], { pmtStreams }), {
        status: 0,
        stream: 9,
    });
});

test('a sub-channel recording made while Mirakurun kept the main channel to the end shows the program, not the main channel', () => {
    // review D18-1: the main channel's video runs to the end of the recording, the PMT lists the program's own
    assert.deepStrictEqual(
        runThumbnail([[0, 1e9, '1440,1080,4:3', 0], [5, 1e9, '720,480,32:27', 30]], { pmtStreams: [30, 31] }),
        { status: 0, stream: 30 },
    );
});

test('a recording shorter than the thumbnail position gets no thumbnail', () => {
    assert.deepStrictEqual(runThumbnail([[0, 30, '1440,1080,4:3', 1]]), { status: 234, stream: null });
});

test("without the program's video 60 s in, the thumbnail is taken as EPGStation's default command takes it", () => {
    // no frame whose SAR is known in the 60 s window (programVideoSize finds nothing), and a failed probe
    assert.deepStrictEqual(runThumbnail([[0, 1e9, '1440,1080,N/A', 1]]), { status: 0, stream: 1 });
    const frames = [[0, 1e9, '1440,1080,4:3', 1]];
    assert.deepStrictEqual(runThumbnail('fail', {}, thumbnailFfmpeg(frames)), { status: 0, stream: 1 });
});

test('the exit status is non-zero when ffmpeg fails or is killed, so EPGStation registers no thumbnail', () => {
    assert.strictEqual(runThumbnail([[0, 1e9, '1440,1080,4:3', 1]], {}, 'exit 3').status, 3);
    // EPGStation counts any code but 0 as a failure (a signal: null)
    assert.notStrictEqual(runThumbnail([[0, 1e9, '1440,1080,4:3', 1]], {}, 'kill -9 $$').status, 0);
});
