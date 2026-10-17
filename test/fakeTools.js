const fs = require('fs');
const path = require('path');

/**
 * Writes a fake ffprobe and a fake ffmpeg into dir (ffprobe next to ffmpeg, where streamEncode.js looks
 * for it).
 * - ffprobe reports audioStreams audio streams, with the stream indexes 1, 11, 21, ... (audio streams are not
 *   numbered consecutively in a broadcast: 1 and 11 in review D13-1's NHK BS capture), and a duration of
 *   outputDuration for a .mkv (enc.js's output) and inputDuration for any other file; a duration of 'fail' makes it
 *   fail. Without -probesize (the default probe, 5 MB) it reports defaultProbeDuration for the input instead, when
 *   given: 'N/A' for a recording with a stream that starts after the first 5 MB (review D18-1). For a .mkv its streams carry the DURATION tag outputAudioDuration, as the Matroska muxer writes it for each
 *   track (the end of the track's last packet), or the content of the .mkv when the fake ffmpeg wrote one (an
 *   ffmpegScript that models how long ffmpeg's audio output is). It answers after probeSeconds seconds.
 *   With -read_intervals +<start>%+<seconds> it prints the audio packets in that part of the input as the real
 *   ffprobe does with -show_entries packet=stream_index:program_stream=index -of json: a {"stream_index": <index>}
 *   packet (3 here) for every audio stream with packets there, and under programs the audio streams that the
 *   program's PMT lists. audioPackets gives each audio stream's [from, to] seconds with packets (a 2nd audio stream
 *   of the previous program only in the recording's lead-in: [0, 5]); without it every stream has packets throughout.
 *   With -select_streams v and -read_intervals it prints instead the video frames in that part of the input
 *   (frame=stream_index,width,height,sample_aspect_ratio:program_stream=index, json) as the real ffprobe does: a
 *   frame (3 here per part) with its stream index, width, height and SAR (no SAR where it is N/A), under programs
 *   the video streams that the PMT lists, and under streams every video stream with its start_time (the broadcast's
 *   time, here 1000 s at the start of the input, plus the start of the stream's first part). videoFrames gives the parts of the video as
 *   [from, to, '<width>,<height>,<sar>', <stream index, default 0>] (a lead-in of the previous program's size:
 *   [0, 15, '720,480,32:27']); the default is 1440x1080 SAR 4:3 throughout, [] no frame at all, and 'fail' makes
 *   that call fail.
 *   With -select_streams s and -read_intervals it prints the caption streams (subtitleStreams, indexes; none by
 *   default) that the PMT lists, under programs; for a recording without a caption stream (CS channels) it fails
 *   as the real ffprobe does ("Could not seek ...: Operation not permitted", exit 1; review C19-1).
 *   pmtStreams lists the stream indexes the program's PMT has where it is read (null: every video, audio and caption
 *   stream). A recording of a sub-channel made while Mirakurun passed every PID the PMT ever listed (review D18-1)
 *   has the main channel's video 0 and audio 1 throughout, the program's own (e.g. video 30, audio 31) from the
 *   end of the lead-in, and the PMT lists only the program's own.
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
        defaultProbeDuration = inputDuration,
        outputDuration = '100',
        audioStreams = 0,
        dualMono = false,
        probeSeconds = 0,
        audioPackets = null,
        videoFrames = [[0, 1e9, '1440,1080,4:3']],
        pmtStreams = null,
        subtitleStreams = [],
        outputAudioDuration = '00:01:40.000000000',
        callLog = null,
        probedSizes = null,
    } = {},
) => {
    const logCall = name => (callLog ? `echo "${name} $*" >> '${callLog}'\n` : '');
    const indexes = Array.from({ length: audioStreams }, (_, i) => i * 10 + 1);
    const streams = JSON.stringify(indexes.map(index => ({ index })));
    // @D@: the DURATION tag, filled in by ffprobe
    const mkvStreams = JSON.stringify(indexes.map(index => ({ index, tags: { DURATION: '@D@' } })));
    // "<index> <from> <to>" for every audio stream
    const packets = indexes.map((index, i) => `${index} ${audioPackets ? audioPackets[i].join(' ') : '0 1e9'}`).join('\\n');
    // "<stream index> <from> <to> <width>,<height>,<sar>" for every part of the video
    const videoParts = videoFrames === 'fail' ? [] : videoFrames.map(([from, to, size, index = 0]) => [index, from, to, size]);
    const frames = videoParts.map(part => part.join(' ')).join('\\n');
    // the streams of a type (indexes) that the PMT lists, as ffprobe prints them under programs
    const pmt = indexesOfType =>
        JSON.stringify([{ streams: indexesOfType.filter(index => pmtStreams === null || pmtStreams.includes(index)).map(index => ({ index })) }]);
    const videoIndexes = [...new Set(videoParts.map(part => part[0]))];
    const videoPmt = pmt(videoIndexes);
    const videoStreams = JSON.stringify(
        videoIndexes.map(index => ({ index, start_time: String(1000 + Math.min(...videoParts.filter(part => part[0] === index).map(part => part[1]))) })),
    );
    // prints the JSON object of awk expression item 3 times for every line ("<index> <from> <to> ...") whose part
    // overlaps the read interval, comma-separated
    const inInterval = item =>
        `awk -v ri="$ri" '{ split(ri, p, "%"); s = substr(p[1], 2) + 0; e = s + substr(p[2], 2); ` +
        `if ($2 < e && $3 > s) for (k = 0; k < 3; k++) print ${item} }' | paste -sd, -`;
    // a frame: {"stream_index":…,"width":…,"height":…[,"sample_aspect_ratio":"…"]} (no SAR where it is N/A)
    const frameItem =
        '"{\\"stream_index\\":" $1 ",\\"width\\":" f[1] ",\\"height\\":" f[2] ' +
        '(f[3] == "N/A" ? "" : ",\\"sample_aspect_ratio\\":\\"" f[3] "\\"") "}"';
    const ffprobe = path.join(dir, 'ffprobe');
    fs.writeFileSync(
        ffprobe,
        `#!/bin/sh\n${logCall('ffprobe')}sleep ${probeSeconds}\nri=; sel=; ps=; prev=; for a; do [ "$prev" = -read_intervals ] && ri="$a"; ` +
            '[ "$prev" = -select_streams ] && sel="$a"; [ "$a" = -probesize ] && ps=1; prev="$a"; last="$a"; done\n' +
            (probedSizes ? `stat -c %s "$last" >> '${probedSizes}'\n` : '') +
            'if [ -n "$ri" ] && [ "$sel" = v ]; then\n' +
            (videoFrames === 'fail'
                ? '  exit 1\n'
                : `  printf '{"frames":[%s],"programs":%s,"streams":%s}\\n' "$([ -n '${frames}' ] && printf '${frames}\\n' | ` +
                  `${inInterval(`(split($4, f, ",") ? ${frameItem} : "")`)})" '${videoPmt}' '${videoStreams}'\n`) +
            '  exit 0\nfi\n' +
            'if [ -n "$ri" ] && [ "$sel" = s ]; then\n' +
            (subtitleStreams.length === 0
                ? "  echo 'Could not seek to 60.000000: Operation not permitted' >&2; exit 1\n"
                : `  printf '%s\\n' '{"packets":[],"programs":${pmt(subtitleStreams)}}'\n`) +
            '  exit 0\nfi\n' +
            'if [ -n "$ri" ]; then\n' +
            `  printf '{"packets":[%s],"programs":%s}\\n' "$([ -n '${packets}' ] && printf '${packets}\\n' | ` +
            `${inInterval('"{\\"stream_index\\":" $1 "}"')})" '${pmt(indexes)}'\n` +
            '  exit 0\nfi\n' +
            `case "$last" in *.mkv) d='${outputDuration}'; a='${outputAudioDuration}'; [ -s "$last" ] && a=$(cat "$last"); ` +
            `st=$(printf '%s' '${mkvStreams}' | sed "s/@D@/$a/g");; *) d='${inputDuration}'; [ -z "$ps" ] && d='${defaultProbeDuration}'; st='${streams}';; esac\n` +
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
