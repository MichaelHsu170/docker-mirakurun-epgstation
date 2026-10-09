const fs = require('fs');
const path = require('path');

/**
 * Writes a fake ffprobe and a fake ffmpeg into dir (ffprobe next to ffmpeg, where streamEncode.js looks
 * for it).
 * - ffprobe reports audioStreams audio streams, and a duration of outputDuration for a .mkv (enc.js's
 *   output) and inputDuration for any other file; a duration of 'fail' makes it fail.
 * - ffmpeg answers the dual-mono check (-dual_mono_mode main/sub) with different audio when dualMono is
 *   true, the same audio when it is false, and fails it when it is 'fail'; any other call runs
 *   ffmpegScript (sh, with the arguments in "$@").
 */
const writeFakeTools = (
    dir,
    { ffmpegScript = 'exit 0', inputDuration = '100', outputDuration = '100', audioStreams = 0, dualMono = false } = {},
) => {
    const streams = JSON.stringify(Array.from({ length: audioStreams }, (_, i) => ({ index: i + 1 })));
    const ffprobe = path.join(dir, 'ffprobe');
    fs.writeFileSync(
        ffprobe,
        '#!/bin/sh\nfor a; do last="$a"; done\n' +
            `case "$last" in *.mkv) d='${outputDuration}';; *) d='${inputDuration}';; esac\n` +
            '[ "$d" = fail ] && exit 1\n' +
            `printf '%s\\n' '{"format":{"duration":"'"$d"'"},"streams":${streams}}'\n`,
        { mode: 0o755 },
    );
    const decode = audio => (dualMono === 'fail' ? 'exit 1' : `echo ${audio}; exit 0`);
    const ffmpeg = path.join(dir, 'ffmpeg');
    fs.writeFileSync(
        ffmpeg,
        '#!/bin/sh\n' +
            `case "$*" in *'-dual_mono_mode main'*) ${decode('main')};; ` +
            `*'-dual_mono_mode sub'*) ${decode(dualMono ? 'sub' : 'main')};; esac\n` +
            `${ffmpegScript}\n`,
        { mode: 0o755 },
    );

    return { ffmpeg, ffprobe };
};

module.exports = { writeFakeTools };
