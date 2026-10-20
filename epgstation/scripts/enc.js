const spawn = require('child_process').spawn;
const execFile = require('child_process').execFile;
const { audioTrackPlan, getDuration, programVideoSize, programSubtitleStreams, PROBE_ARGS } = require('./lib/audioTrackPlan.js');
const ffmpeg = process.env.FFMPEG;
const ffprobe = process.env.FFPROBE;

const input = process.env.INPUT;
const output = process.env.OUTPUT;

// GPU (NVENC/CUDA) と CPU (libx264) を切り替えるフラグ
// config.yml の encode.cmd に渡す引数 (gpu/cpu) で指定する。省略時は gpu。
const USE_GPU = process.argv[2] !== 'cpu';

// 出力が入力よりこの秒数を超えて短ければエンコード失敗とする (正常なエンコードでも先頭のキーフレーム
// までの分などで数秒は短くなるため、割合ではなく秒数で判定する)。
// 出力の最初の音声トラックが出力よりこの秒数を超えて早く終わる場合も失敗とする (番組の音声が map されず、
// 音声が先頭の数秒しかない出力。実測で正常なエンコードの差は 0.5 秒以下、音声のない出力は 3400 秒以上)。
// 無音の部分にも音声のパケットはあり、タイムスタンプの飛びを詰めた分は映像と音声の両方から詰められるため差にならない
const MAX_MISSING_SECONDS = 5;

// 1つ目の入力 (映像と音声) を読む速さの上限 (再生速度の 12 倍)。ffmpeg 9 は1つの入力の映像と音声を実時間より
// 速くデコードすると、エンコードに使われる前に読んだ分をメモリに溜め、番組の長さに比例して増える (1 時間あたり
// 約 2.3-2.7 GB、3 時間の番組で 7.3 GB)。エンコードの速さ (GPU で 10-14 倍速) 程度で読めば溜まらない (1 GB 未満)。
// 代わりに GPU のエンコードは 2 割強遅くなる。字幕用の入力には付けない (字幕のない番組でその先読みが遅くならないように)
const READRATE_ARGS = ['-readrate', '12'];

// 字幕は同じ録画を2つ目の入力として開いて取る (映像と音声は1つ目の入力から)。
// srcs/ffmpeg の字幕デコーダ (libaribb24) が付ける表示時間は次の字幕と重なるか、終わりがない (1193 時間) ため、
// -fix_sub_duration で次の字幕の始まりまでとする。その間 ffmpeg は字幕を出力せずに持っており、出力の字幕
// ストリームが進まない。ffmpeg 9 は進みの遅いストリームの入力を読ませ、他のストリームを止めるため、字幕と
// 映像・音声が同じ入力だと、字幕のない番組 (前の番組から入った字幕が1つだけ) では録画の終わりまで入力を
// メモリに読み込むか、音声を落とした出力になる。2つ目の入力にすると、そちらだけが次の字幕まで先に読まれる。
// -isync 0 で1つ目の入力と同じだけタイムスタンプをずらす (字幕の時刻は1つの入力のときと同じ)。
// 2つ目の入力の映像も (null 出力に) map するのは、受信が途切れた所 (DISCONTINUITY_REG) を2つ目の入力でも
// 検出して詰め、その後の字幕が詰めた分だけ遅れないようにするため (字幕だけでは検出されない)
const CAPTION_INPUT_ARGS = ['-fix_sub_duration', '-isync', '0'];

// ffmpeg は入力 (mpegts) のタイムスタンプが -dts_delta_threshold (既定 10 秒) を超えて飛ぶと、以降のタイム
// スタンプをずらしてその間を詰める (受信が途切れて TS にもデータがない部分など)。その警告行の
// "new offset= N" は入力全体の累積のずれ (µs) で、負の値の分だけ出力は入力より短くなる。
// 例: [aist#0:3/aac @ 0x5f...] timestamp discontinuity (stream id=273): 10176000, new offset= -10176000
const DISCONTINUITY_REG = /timestamp discontinuity .*new offset= (-?\d+)/;

/**
 * 出力 (mkv) の最初の音声トラックの長さ (Matroska の DURATION タグ: そのトラックの最後のパケットの終わり)
 * @param {string} filePath ファイルパス
 * @return {Promise<number>} 秒
 */
const getAudioDuration = filePath => {
    return new Promise((resolve, reject) => {
        execFile(ffprobe, ['-v', '0', '-select_streams', 'a:0', '-show_entries', 'stream_tags=DURATION', '-of', 'json', filePath], (err, stdout) => {
            if (err) {
                reject(err);

                return;
            }

            try {
                // 例: "00:59:50.399000000"
                const tag = JSON.parse(stdout).streams[0].tags.DURATION.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
                resolve(parseInt(tag[1], 10) * 3600 + parseInt(tag[2], 10) * 60 + parseFloat(tag[3]));
            } catch (err) {
                reject(err);
            }
        });
    });
};

(async () => {
    // 進捗計算のために動画の長さを取得
    const duration = await getDuration(ffprobe, input, PROBE_ARGS);
    // 音声ストリーム構成 (実ストリーム数・二カ国語判定) を実際にデコードして判定する。
    // EPG由来のメタデータ (AUDIOCOMPONENTTYPE) は誤りや欠落があり得るため信頼しない。
    // 二カ国語と map する音声ストリームは先頭 (前の番組の音声が入る) ではなく番組の中の音声で判定する
    // (audioTrackPlan.js の DUAL_MONO_JUDGE_START)
    const plan = await audioTrackPlan(ffprobe, ffmpeg, input, PROBE_ARGS, false, duration);
    // 番組の映像ストリームと大きさ (先頭の前の番組の部分ではなく、二カ国語と同じく番組の中で判定する)
    const videoSize = await programVideoSize(ffprobe, input, PROBE_ARGS, duration);
    // 番組の字幕ストリーム (サブチャンネルの録画の先頭のメインチャンネルの字幕を除く)
    const subtitleStreams = await programSubtitleStreams(ffprobe, input, PROBE_ARGS, videoSize === null ? undefined : videoSize.streams[0]);

    const args = ['-y'];
    // NVidia GPU
    if (USE_GPU) {
        Array.prototype.push.apply(args, ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']);
    }
    if (!plan.filterComplex) {
        // 判定区間 (60 秒目からの 5 秒) の外にある二カ国語 (dual-mono) の部分 (先頭に残る前の番組の音声や、
        // 番組の途中の二カ国語) も主音声のみを出す。
        // channelsplit で両方を分ける場合は両チャンネルが必要なため付けない
        Array.prototype.push.apply(args, ['-dual_mono_mode', 'main']);
    }
    // input 設定 (読む速さの上限: READRATE_ARGS)
    Array.prototype.push.apply(args, [...READRATE_ARGS, ...PROBE_ARGS, '-i', input]);
    // 字幕用 (同じ録画をもう一度、字幕だけのために開く: CAPTION_INPUT_ARGS)
    Array.prototype.push.apply(args, CAPTION_INPUT_ARGS);
    Array.prototype.push.apply(args, [...PROBE_ARGS, '-i', input]);
    // 音声ストリーム分割 (二カ国語放送の場合のみ channelsplit を適用)
    if (plan.filterComplex) {
        Array.prototype.push.apply(args, ['-filter_complex', plan.filterComplex]);
    }
    // ビデオストリーム設定: 番組の映像だけ (前の番組の部分にしかない映像や、サブチャンネルの録画に入った
    // メインチャンネルの映像は除く。programVideoSize)。判定区間にフレームがなければ全ての映像
    const videoMapArgs = videoSize === null ? ['-map', '0:v'] : videoSize.streams.flatMap(index => ['-map', `0:${index}`]);
    Array.prototype.push.apply(args, [...videoMapArgs, '-c:v', USE_GPU ? 'h264_nvenc' : 'libx264']);
    // インターレス解除
    let videoFilter = USE_GPU ? 'yadif_cuda' : 'yadif';
    // 録画の途中で同じ映像ストリームの大きさが変わっても (先頭の前の番組の部分の大きさが違う) 番組の大きさと
    // SAR にそろえる (サブチャンネルが番組の境目で 1080i と 480i を切り替えるときは PID も変わり、前の番組の映像は
    // map されない)。エンコーダは最初のフレームの大きさで開かれ、h264_nvenc は
    // 大きさの違う CUDA のフレームをそのまま受け取って崩れた映像 (小さい映像の周りがゴミ、大きい映像は左上だけ)
    // を出力し、ffmpeg は 0 で終わるため、CPU のメモリに移してから scale する (同じ大きさならそのまま通る。
    // scale_cuda は大きさが変わると ffmpeg が落ちる)。libx264 は ffmpeg が最初のフレームの大きさにそろえる
    // (前の番組の大きさになる) ため同じく番組の大きさにする。判定区間にフレームがなければそろえない
    if (videoSize !== null) {
        videoFilter += `${USE_GPU ? ',hwdownload,format=nv12' : ''},scale=${videoSize.width}:${videoSize.height},setsar=${videoSize.sar}`;
    }
    Array.prototype.push.apply(args, ['-vf', videoFilter]);
    // オーディオストリーム設定
    Array.prototype.push.apply(args, plan.audioMapArgs);
    if (plan.trackCount > 0) {
        Array.prototype.push.apply(args, ['-c:a', 'aac']);
        if (plan.filterComplex) {
            Array.prototype.push.apply(args, ['-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=eng']);
        }
    }
    // 字幕ストリーム設定: 番組の字幕 (programSubtitleStreams。2つ目の入力のストリーム番号は1つ目と同じ)。字幕ストリームが
    // なければ 1:s? (何も map しない)
    const subtitleMapArgs = subtitleStreams === null ? ['-map', '1:s?'] : subtitleStreams.flatMap(index => ['-map', `1:${index}`]);
    Array.prototype.push.apply(args, [...subtitleMapArgs, '-c:s', 'srt']);
    // 品質設定 (libx264のみ、h264_nvencでは-crfが無効なため)
    if (!USE_GPU) {
        Array.prototype.push.apply(args, ['-preset', 'veryfast', '-crf', '26']);
    }
    // 出力ファイル
    Array.prototype.push.apply(args, [output]);
    // 字幕用の入力の映像は捨てる (CAPTION_INPUT_ARGS)。1つ目の入力と同じ番組の映像にする (メインチャンネルの前の番組の
    // 映像から始めると、字幕がその分遅れる)
    const captionVideoMapArgs = videoSize === null ? ['-map', '1:v'] : videoSize.streams.flatMap(index => ['-map', `1:${index}`]);
    Array.prototype.push.apply(args, [...captionVideoMapArgs, '-c', 'copy', '-f', 'null', '-']);

    const child = spawn(ffmpeg, args);

    // キャンセル時、EPGStation は先に stdout/stderr を閉じてから SIGINT を送る。閉じたパイプへの
    // 書き込みエラー (EPIPE) で enc.js が先に落ちると SIGINT を ffmpeg に転送できず、ffmpeg が
    // 終了せずに残るため、書き込みエラーは無視して enc.js が終了するときは ffmpeg も止める
    process.stdout.on('error', () => {});
    process.stderr.on('error', () => {});
    process.on('exit', () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGINT');
        }
    });
    process.stderr.write('ffmpeg command: ' + ffmpeg + ' ' + args.join(' ') + '\n');

    /**
     * エンコード進捗表示用に標準出力に進捗情報を吐き出す
     * 出力する JSON
     * {"type":"progress","percent": 0.8, "log": "view log" }
     */
    // ffmpeg は進捗行を \r で終え、エラーなどは \n で終える。チャンクの境界は行の途中にもなるため、
    // 最後の不完全な行は次のチャンクと合わせて処理する
    let stderrRest = '';
    // 最後に報告された累積のずれ (µs)
    let discontinuityOffset = 0;
    child.stderr.on('data', data => {
        let strbyline = (stderrRest + String(data)).split(/[\r\n]+/);
        stderrRest = strbyline.pop();
        for (let i = 0; i < strbyline.length; i++) {
            let str = strbyline[i];
            if (!str.startsWith('frame')) {
                // non-progress line (version info, errors, stream mapping etc.) — forward to stderr
                if (str !== '') process.stderr.write(str + '\n');
                const discontinuity = str.match(DISCONTINUITY_REG);
                if (discontinuity !== null) {
                    discontinuityOffset = parseInt(discontinuity[1], 10);
                }
                continue;
            }
            if (str.startsWith('frame')) {
                // 想定log
                // frame= 5159 fps= 11 q=29.0 size=  122624kB time=00:02:51.84 bitrate=5845.8kbits/s dup=19 drop=0 speed=0.372x
                // srcs/ffmpeg (ffmpeg 9) ではサイズの単位が KiB (size=  122624KiB)。
                // 2つ目の映像 (字幕用の入力の映像の null 出力) の q も続く (q=21.0 q=-1.0、最後の行は q=23.0 Lq=-1.0)
                const progress = {};
                const ffmpeg_reg = /frame=\s*(?<frame>\d+)\sfps=\s*(?<fps>\d+(?:\.\d+)?)\sq=\s*(?<q>[+-]?\d+(?:\.\d+)?)(?:\sL?q=\s*[+-]?\d+(?:\.\d+)?)*\sL?size=\s*(?<size>\d+(?:\.\d+)?)(?:kB|KiB)\stime=\s*(?<time>\d+[:\.\d+]*)\sbitrate=\s*(?<bitrate>\d+(?:\.\d+)?)kbits\/s(?:\sdup=\s*(?<dup>\d+))?(?:\sdrop=\s*(?<drop>\d+))?\sspeed=\s*(?<speed>\d+(?:\.\d+)?)x/;
                let ffmatch =str.match(ffmpeg_reg);
                /**
                 * match結果
                 * [
                 *   'frame= 5159 fps= 11 q=29.0 size=  122624kB time=00:02:51.84 bitrate=5845.8kbits/s dup=19 drop=0 speed=0.372x',
                 *   '5159',
                 *   '11',
                 *   '29.0',
                 *   '122624',
                 *   '00:02:51.84',
                 *   '5845.8',
                 *   '19',
                 *   '0',
                 *   '0.372',
                 *   index: 0,
                 *   input: 'frame= 5159 fps= 11 q=29.0 size=  122624kB time=00:02:51.84 bitrate=5845.8kbits/s dup=19 drop=0 speed=0.372x    \r',
                 *   groups: [Object: null prototype] {
                 *     frame: '5159',
                 *     fps: '11',
                 *     q: '29.0',
                 *     size: '122624',
                 *     time: '00:02:51.84',
                 *     bitrate: '5845.8',
                 *     dup: '19',
                 *     drop: '0',
                 *     speed: '0.372'
                 *   }
                 * ]
                 */

                if (ffmatch === null) {
                    process.stderr.write(str + '\n');
                    continue;
                }

                progress['frame'] = parseInt(ffmatch.groups.frame);
                progress['fps'] = parseFloat(ffmatch.groups.fps);
                progress['q'] = parseFloat(ffmatch.groups.q);
                progress['size'] = parseInt(ffmatch.groups.size);
                progress['time'] = ffmatch.groups.time;
                progress['bitrate'] = parseFloat(ffmatch.groups.bitrate);
                progress['dup'] = ffmatch.groups.dup == null ? 0 : parseInt(ffmatch.groups.dup);
                progress['drop'] = ffmatch.groups.drop == null ? 0 : parseInt(ffmatch.groups.drop);
                progress['speed'] = parseFloat(ffmatch.groups.speed);

                let current = 0;
                const times = progress.time.split(':');
                for (let i = 0; i < times.length; i++) {
                    if (i == 0) {
                        current += parseFloat(times[i]) * 3600;
                    } else if (i == 1) {
                        current += parseFloat(times[i]) * 60;
                    } else if (i == 2) {
                        current += parseFloat(times[i]);
                    }
                }

                // 進捗率 1.0 で 100%
                const percent = current / duration;
                const log =
                    'frame= ' +
                    progress.frame +
                    ' fps=' +
                    progress.fps +
                    ' size=' +
                    progress.size +
                    ' time=' +
                    progress.time +
                    ' bitrate=' +
                    progress.bitrate +
                    ' drop=' +
                    progress.drop +
                    ' speed=' +
                    progress.speed;

                console.log(JSON.stringify({ type: 'progress', percent: percent, log: log }));
            }
        }
    });

    child.stderr.on('end', () => {
        if (stderrRest !== '') process.stderr.write(stderrRest + '\n');
    });

    child.on('error', err => {
        console.error(err);
        throw new Error(err);
    });

    // シグナルで終了した場合 code は null になる。そのまま exitCode に渡すと 0 (成功) 扱いになり、
    // EPGStation が途中までのファイルを登録して元ファイルを削除してしまうため失敗として返す
    child.on('close', async (code) => {
        process.exitCode = code === null ? 1 : code;
        if (process.exitCode !== 0) {
            return;
        }

        // ffmpeg が正常終了しても入力の欠落部分を詰めて短い動画を出力することがある。
        // 成功扱いにすると元ファイルが削除されて欠落部分が失われるため、出力が入力より
        // MAX_MISSING_SECONDS 秒を超えて短ければ失敗として返す。ただし ffmpeg がタイムスタンプの飛びを
        // 詰めた時間 (DISCONTINUITY_REG) は入力にデータがなく失われないため、その分も短くてよい。
        // 番組の映像の前の、別のストリームにしかない前の番組の部分 (programVideoSize の leadInSeconds) はエンコードしない
        // ため、その分も短くてよい。入力の長さが分からない場合はこの判定はしない (音声の長さは出力だけで判定する)
        const isDurationKnown = Number.isFinite(duration) && duration > 0;
        if (!isDurationKnown) {
            console.error(`enc.js: input duration is unknown (${duration}): not checking the output duration`);
        }
        try {
            const outputDuration = await getDuration(ffprobe, output);
            if (isDurationKnown) {
                const closedSeconds = Math.max(0, -discontinuityOffset / 1e6);
                const leadInSeconds = videoSize === null ? 0 : videoSize.leadInSeconds;
                const programDuration = duration - leadInSeconds;
                const inputText = `input is ${duration}s${leadInSeconds > 0 ? ` (${leadInSeconds}s of it before the program's own video, not encoded)` : ''}`;
                if (!(outputDuration >= programDuration - MAX_MISSING_SECONDS - closedSeconds)) {
                    console.error(
                        `enc.js: output is ${outputDuration}s, ${inputText}, of which ffmpeg closed up ${closedSeconds}s of timestamp gaps: treating the encode as failed`,
                    );
                    process.exitCode = 1;
                    return;
                }
                if (!(outputDuration >= programDuration - MAX_MISSING_SECONDS)) {
                    console.error(
                        `enc.js: output is ${outputDuration}s, ${inputText}: ffmpeg closed up ${closedSeconds}s of timestamp gaps (no data in the input), so the output is complete`,
                    );
                }
            }
            // 音声が途中で途切れた出力も成功扱いにすると元ファイルが削除されて音声が失われる
            if (plan.trackCount > 0) {
                const audioDuration = await getAudioDuration(output);
                if (!(audioDuration >= outputDuration - MAX_MISSING_SECONDS)) {
                    console.error(
                        `enc.js: the first audio track is ${audioDuration}s, the output is ${outputDuration}s: treating the encode as failed`,
                    );
                    process.exitCode = 1;
                }
            }
        } catch (err) {
            console.error('enc.js: cannot read the output duration or its audio duration:', err);
            process.exitCode = 1;
        }
    });

    process.on('SIGINT', () => {
        child.kill('SIGINT');
    });
})().catch(err => {
    // getDuration/audioTrackPlan が reject した場合 (ffprobe/ffmpeg 起動失敗など) に
    // 未処理のまま落ちると原因が分かりにくいため、明示的にログしてから終了する。
    console.error('enc.js: fatal error:', err);
    process.exitCode = 1;
});
