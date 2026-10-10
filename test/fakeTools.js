const fs = require('fs');
const path = require('path');

/**
 * Writes a fake ffprobe and a fake ffmpeg into dir (ffprobe next to ffmpeg, where streamEncode.js looks
 * for it).
 * - ffprobe reports audioStreams audio streams, and a duration of outputDuration for a .mkv (enc.js's
 *   output) and inputDuration for any other file; a duration of 'fail' makes it fail. It answers after
 *   probeSeconds seconds.
 * - ffmpeg answers the dual-mono check (-v error -dual_mono_mode main/sub) as the real ffmpeg does with the
 *   arguments that check gives ([-ss <seconds>] -i ... -t <seconds> -f s16le): it writes the audio from the -ss
 *   position (0 without it) for the -t seconds or to the end of the audio, whichever comes first, as 192000 bytes of
 *   PCM per second (48 kHz stereo, as broadcast AAC decodes), in the chunks head writes. dualMono is the audio, as
 *   [seconds, isDualMono] parts from the start of the input: where a part is dual mono, the main and the sub decode
 *   differ (as the AAC decoder's output for the two languages does), elsewhere they are identical (dual_mono_mode has
 *   no effect on stereo or mono audio). A recording's lead-in from the previous program is a first part of its own
 *   (review D12-1: 5-19 s). true is 100 s of dual mono, false 100 s of stereo (the default inputDuration), and 'fail'
 *   fails the check. Any other call runs ffmpegScript (sh, with the arguments in "$@").
 * - with callLog, both append a line "<ffprobe|ffmpeg> <arguments>" to that file for every call.
 * - with probedSizes, ffprobe appends the size in bytes of the file it probes to that file.
 */
const writeFakeTools = (
    dir,
    {
        ffmpegScript = 'exit 0',
        inputDuration = '100',
        outputDuration = '100',
        audioStreams = 0,
        dualMono = false,
        probeSeconds = 0,
        callLog = null,
        probedSizes = null,
    } = {},
) => {
    const logCall = name => (callLog ? `echo "${name} $*" >> '${callLog}'\n` : '');
    const streams = JSON.stringify(Array.from({ length: audioStreams }, (_, i) => ({ index: i + 1 })));
    const ffprobe = path.join(dir, 'ffprobe');
    fs.writeFileSync(
        ffprobe,
        `#!/bin/sh\n${logCall('ffprobe')}sleep ${probeSeconds}\nfor a; do last="$a"; done\n` +
            (probedSizes ? `stat -c %s "$last" >> '${probedSizes}'\n` : '') +
            `case "$last" in *.mkv) d='${outputDuration}';; *) d='${inputDuration}';; esac\n` +
            '[ "$d" = fail ] && exit 1\n' +
            `printf '%s\\n' '{"format":{"duration":"'"$d"'"},"streams":${streams}}'\n`,
        { mode: 0o755 },
    );
    const parts = dualMono === true ? [[100, true]] : dualMono === false ? [[100, false]] : dualMono;
    // main: zero samples throughout; sub: other samples where the audio is dual mono
    const pcm = lang =>
        dualMono === 'fail'
            ? 'exit 1'
            : '{ ' +
              parts
                  .map(([seconds, isDualMono]) => {
                      return `head -c ${Math.round(seconds * 48000) * 4} /dev/zero${lang === 'sub' && isDualMono ? " | tr '\\0' '\\1'" : ''};`;
                  })
                  .join(' ') +
              ' } | tail -c +$((skip + 1)) | head -c $((${t:-1000} * 192000)); exit 0';
    const ffmpeg = path.join(dir, 'ffmpeg');
    fs.writeFileSync(
        ffmpeg,
        '#!/bin/sh\n' +
            logCall('ffmpeg') +
            't=; ss=0; prev=; for a; do [ "$prev" = -t ] && t="$a"; [ "$prev" = -ss ] && ss="$a"; prev="$a"; done\n' +
            // whole samples (4 bytes each) before the -ss position
            'skip=$(awk -v ss="$ss" \'BEGIN { printf "%d", int(ss * 48000) * 4 }\')\n' +
            `case "$*" in *'-v error -dual_mono_mode main'*) ${pcm('main')};; ` +
            `*'-v error -dual_mono_mode sub'*) ${pcm('sub')};; esac\n` +
            `${ffmpegScript}\n`,
        { mode: 0o755 },
    );

    return { ffmpeg, ffprobe };
};

module.exports = { writeFakeTools };
