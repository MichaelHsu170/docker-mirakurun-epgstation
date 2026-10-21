const fs = require('fs');
const path = require('path');

/**
 * Writes a fake ffprobe and a fake ffmpeg into dir (ffprobe next to ffmpeg, where streamEncode.js looks
 * for it).
 * - ffprobe reports audioStreams audio streams, with the stream indexes 1, 11, 21, ... (audio streams are not
 *   numbered consecutively in a broadcast: 1 and 11 in review D13-1's NHK BS capture) and the PIDs (id) 0x110, 0x111,
 *   0x112, ..., and a duration of
 *   outputDuration for a .mkv (enc.js's output) and inputDuration for any other file; a duration of 'fail' makes it
 *   fail. Without -probesize (the default probe, 5 MB) it reports defaultProbeDuration for the input instead, when
 *   given: 'N/A' for a recording with a stream that starts after the first 5 MB (review D18-1). For a .mkv its streams carry the DURATION tag outputAudioDuration, as the Matroska muxer writes it for each
 *   track (the end of the track's last packet), or the content of the .mkv when the fake ffmpeg wrote one (an
 *   ffmpegScript that models how long ffmpeg's audio output is). It answers after probeSeconds seconds.
 *   With -read_intervals +<start>%+<seconds> it prints the audio packets in that part of the input as the real
 *   ffprobe does with -show_entries packet=stream_index:program_stream=index -of json: a {"stream_index": <index>}
 *   packet (3 here) for every audio stream with packets there, and under programs the audio streams of pmtStreams.
 *   audioPackets gives each audio stream's [from, to] seconds with packets (a
 *   2nd audio stream of the previous program only in the recording's lead-in: [0, 5]); without it every stream has
 *   packets throughout. The input is BYTES_PER_SECOND bytes per second. As the real ffprobe with PROBE_ARGS (the
 *   30 s stream probe), every -select_streams a call finds only the audio streams whose first packet is less than
 *   30 s after where it opens the input: the start, or with -skip_initial_bytes <n>, n / BYTES_PER_SECOND s in, where
 *   it finds only the streams with packets after that point (the PMT there). A stream whose packets start later is
 *   not an audio stream for it (the real one reports it as codec_type unknown, codec_tag 0x0f, and a stream that a
 *   later PMT adds not at all: review D20-1, checked on real captures with the audio removed from the first 33 s and
 *   with a 2nd audio PID added to the PMT 40 s in). A -skip_initial_bytes value that is not a number fails, as with
 *   the real ffprobe.
 *   With -select_streams v and -read_intervals it prints instead the video frames in that part of the input
 *   (frame=stream_index,width,height,sample_aspect_ratio:program_stream=index:stream=index,start_time, json) as the
 *   real ffprobe does: a frame (3 here per part) with its stream index, width, height and SAR (no SAR where it is
 *   N/A), under programs the video streams of pmtStreams, and under streams
 *   every video stream with its start_time (the broadcast's time, here 1000 s at the start of the input, plus the
 *   start of the stream's first part). videoFrames gives the parts of the video as
 *   [from, to, '<width>,<height>,<sar>', <stream index, default 0>] (a lead-in of the previous program's size:
 *   [0, 15, '720,480,32:27']); the default is 1440x1080 SAR 4:3 throughout, [] no frame at all, and 'fail' makes
 *   that call fail. With -show_entries packet=pos it prints instead the byte positions of video packets in that part
 *   ({"packets":[{"pos":"<n>"}, ...]}, as strings like the real ffprobe; none for 'fail'). Without -probesize (the default 5 MB probe) it lists no frame of a video stream whose first part
 *   starts 2 s or more into the input. What the real default probe misses is a stream that a later PMT adds: a
 *   sub-channel program's own video after the main channel's lead-in (BS日テレ 142: stream 9 from 4.8-5.6 s in;
 *   review D21-1, D22-2), which starts at the switch in a recording. A stream of the first PMT whose data starts late
 *   is still found 4.3 s in (and at 8.5 s in, the probe fails instead); no test has one.
 *   With -select_streams s (and -show_entries stream=index, no -read_intervals) it prints the caption streams
 *   (subtitleStreams, indexes; none by default: an empty list, as the real ffprobe prints for a CS recording). The
 *   real ffmpeg numbers a recording's streams in the order of its PMT (video first) and those that a later PMT adds
 *   after them, so a sub-channel recording has the main channel's lead-in streams (e.g. video 1, captions 3) before
 *   the program's own (video 10, captions 12).
 *   pmtStreams lists the streams that ffprobe prints under programs (null: every stream). It is not the PMT where the
 *   input is read (review D22-2): on real BS日テレ 142 switches it still held the earlier PMT's video and caption
 *   streams (on TOKYO MX switches only the program's own streams, review D23-2), but not its audio stream, whose last 2 packets (the audio ended 6 s in) ffprobe still printed in the
 *   60-65 s window (audioPackets [0, 1e9] models that).
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
/** The bytes per second of the fake input (about a GR recording's 16 Mbps) */
const BYTES_PER_SECOND = 2000000;

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
    const ids = indexes.map((_, i) => `0x${(0x110 + i).toString(16)}`);
    const startOfAudio = i => (audioPackets ? audioPackets[i][0] : 0);
    // the audio streams that the 30 s stream probe from the start of the input finds
    const found = indexes.filter((_, i) => startOfAudio(i) < 30);
    const streams = JSON.stringify(indexes.map((index, i) => ({ index, id: ids[i] })).filter(stream => found.includes(stream.index)));
    // @D@: the DURATION tag, filled in by ffprobe
    const mkvStreams = JSON.stringify(indexes.map(index => ({ index, tags: { DURATION: '@D@' } })));
    // "<index> <from> <to>" for every audio stream
    const audioLines = indexes.map((index, i) => `${index} ${audioPackets ? audioPackets[i].join(' ') : '0 1e9'} ${ids[i]}`);
    const packets = audioLines.filter((_, i) => found.includes(indexes[i])).join('\\n');
    // "<stream index> <from> <to> <width>,<height>,<sar>" for every part of the video
    const videoParts = videoFrames === 'fail' ? [] : videoFrames.map(([from, to, size, index = 0]) => [index, from, to, size]);
    const frames = videoParts.map(part => part.join(' ')).join('\\n');
    // the frames that the default probe (no -probesize: 5 MB, about 2 s of BS) finds: none of a video stream that
    // starts later (a sub-channel program's own video after the main channel's lead-in)
    const firstStart = index => Math.min(...videoParts.filter(part => part[0] === index).map(part => part[1]));
    const defaultProbeFrames = videoParts
        .filter(part => firstStart(part[0]) < 2)
        .map(part => part.join(' '))
        .join('\\n');
    // the streams of a type (indexes) that ffprobe prints under programs
    const pmt = indexesOfType =>
        JSON.stringify([{ streams: indexesOfType.filter(index => pmtStreams === null || pmtStreams.includes(index)).map(index => ({ index })) }]);
    const videoIndexes = [...new Set(videoParts.map(part => part[0]))];
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
        `#!/bin/sh\n${logCall('ffprobe')}sleep ${probeSeconds}\nri=; sel=; ps=; se=; sk=; prev=; for a; do [ "$prev" = -read_intervals ] && ri="$a"; ` +
            '[ "$prev" = -select_streams ] && sel="$a"; [ "$prev" = -show_entries ] && se="$a"; [ "$prev" = -skip_initial_bytes ] && sk="$a"; ' +
            '[ "$a" = -probesize ] && ps=1; prev="$a"; last="$a"; done\n' +
            (probedSizes ? `stat -c %s "$last" >> '${probedSizes}'\n` : '') +
            'if [ -n "$ri" ] && [ "$sel" = v ] && [ "$se" = packet=pos ]; then\n' +
            `  printf '{"packets":[%s]}\\n' "$([ -n '${frames}' ] && printf '${frames}\\n' | ` +
            `${inInterval(`"{\\"pos\\":\\"" int((($2 > s ? $2 : s) + k) * ${BYTES_PER_SECOND}) "\\"}"`)})"\n` +
            '  exit 0\nfi\n' +
            'if [ -n "$ri" ] && [ "$sel" = v ]; then\n' +
            (videoFrames === 'fail'
                ? '  exit 1\n'
                : `  f='${frames}'; [ -z "$ps" ] && f='${defaultProbeFrames}'\n` +
                  `  printf '{"frames":[%s],"programs":%s,"streams":%s}\\n' "$([ -n "$f" ] && printf "$f\\n" | ` +
                  `${inInterval(`(split($4, f, ",") ? ${frameItem} : "")`)})" '${pmt(videoIndexes)}' '${videoStreams}'\n`) +
            '  exit 0\nfi\n' +
            'if [ -n "$sk" ]; then\n' +
            // the real ffprobe fails on a value that is not a number ("Unable to parse \"skip_initial_bytes\" option value")
            '  case "$sk" in *[!0-9]*) exit 1;; esac\n' +
            `  printf '{"streams":[%s]}\\n' "$([ -n '${audioLines.join('\\n')}' ] && printf '${audioLines.join('\\n')}\\n' | ` +
            `awk -v t="$sk" '{ t0 = t / ${BYTES_PER_SECOND}; if ($2 < t0 + 30 && $3 > t0) print "{\\"index\\":" $1 ",\\"id\\":\\"" $4 "\\"}" }' | paste -sd, -)"\n` +
            '  exit 0\nfi\n' +
            'if [ "$sel" = s ]; then\n' +
            `  printf '%s\\n' '${JSON.stringify({ streams: subtitleStreams.map(index => ({ index })) })}'\n` +
            '  exit 0\nfi\n' +
            'if [ -n "$ri" ]; then\n' +
            `  printf '{"packets":[%s],"programs":%s}\\n' "$([ -n '${packets}' ] && printf '${packets}\\n' | ` +
            `${inInterval('"{\\"stream_index\\":" $1 "}"')})" '${pmt(found)}'\n` +
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
