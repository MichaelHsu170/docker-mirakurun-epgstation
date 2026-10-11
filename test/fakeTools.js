const fs = require('fs');
const path = require('path');

/**
 * Writes a fake ffprobe and a fake ffmpeg into dir (ffprobe next to ffmpeg, where streamEncode.js looks
 * for it).
 * - ffprobe reports audioStreams audio streams, with the stream indexes 1, 11, 21, ... (audio streams are not
 *   numbered consecutively in a broadcast: 1 and 11 in review D13-1's NHK BS capture), and a duration of
 *   outputDuration for a .mkv (enc.js's output) and inputDuration for any other file; a duration of 'fail' makes it
 *   fail. For a .mkv its streams carry the DURATION tag outputAudioDuration, as the Matroska muxer writes it for each
 *   track (the end of the track's last packet). It answers after probeSeconds seconds.
 *   With -read_intervals +<start>%+<seconds> it prints the audio packets (packet=stream_index, csv) in that part of
 *   the input as the real ffprobe does: one "<index>," line per packet (3 here) for every audio stream with packets
 *   there. audioPackets gives each audio stream's [from, to] seconds with packets (a 2nd audio stream of the previous
 *   program only in the recording's lead-in: [0, 5]); without it every stream has packets throughout.
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
        audioPackets = null,
        outputAudioDuration = '00:01:40.000000000',
        callLog = null,
        probedSizes = null,
    } = {},
) => {
    const logCall = name => (callLog ? `echo "${name} $*" >> '${callLog}'\n` : '');
    const indexes = Array.from({ length: audioStreams }, (_, i) => i * 10 + 1);
    const streams = JSON.stringify(indexes.map(index => ({ index })));
    const mkvStreams = JSON.stringify(indexes.map(index => ({ index, tags: { DURATION: outputAudioDuration } })));
    // "<index> <from> <to>" for every audio stream
    const packets = indexes.map((index, i) => `${index} ${audioPackets ? audioPackets[i].join(' ') : '0 1e9'}`).join('\\n');
    const ffprobe = path.join(dir, 'ffprobe');
    fs.writeFileSync(
        ffprobe,
        `#!/bin/sh\n${logCall('ffprobe')}sleep ${probeSeconds}\nri=; prev=; for a; do [ "$prev" = -read_intervals ] && ri="$a"; prev="$a"; last="$a"; done\n` +
            (probedSizes ? `stat -c %s "$last" >> '${probedSizes}'\n` : '') +
            'if [ -n "$ri" ]; then\n' +
            `  printf '${packets}\\n' | awk -v ri="$ri" '{ split(ri, p, "%"); s = substr(p[1], 2) + 0; e = s + substr(p[2], 2); ` +
            'if ($2 < e && $3 > s) for (k = 0; k < 3; k++) print $1 "," }\'\n' +
            '  exit 0\nfi\n' +
            `case "$last" in *.mkv) d='${outputDuration}'; st='${mkvStreams}';; *) d='${inputDuration}'; st='${streams}';; esac\n` +
            '[ "$d" = fail ] && exit 1\n' +
            `printf '%s\\n' '{"format":{"duration":"'"$d"'"},"streams":'"$st"'}'\n`,
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
