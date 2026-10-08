const spawn = require('child_process').spawn;
const execFile = require('child_process').execFile;
const { audioTrackPlan } = require('./lib/audioTrackPlan.js');
const ffmpeg = process.env.FFMPEG;
const ffprobe = process.env.FFPROBE;

const input = process.env.INPUT;
const output = process.env.OUTPUT;

// GPU (NVENC/CUDA) と CPU (libx264) を切り替えるフラグ
// config.yml の encode.cmd に渡す引数 (gpu/cpu) で指定する。省略時は gpu。
const USE_GPU = process.argv[2] !== 'cpu';

// 出力の長さがこの割合未満ならエンコード失敗とする (正常なエンコードは入力の 98〜100%)
const MIN_DURATION_RATIO = 0.97;

/**
 * 動画長取得関数
 * @param {string} filePath ファイルパス
 * @return number 動画長を返す (秒)
 */
const getDuration = filePath => {
    return new Promise((resolve, reject) => {
        execFile(ffprobe, ['-v', '0', '-show_format', '-of', 'json', filePath], (err, stdout) => {
            if (err) {
                reject(err);

                return;
            }

            try {
                const result = JSON.parse(stdout);
                resolve(parseFloat(result.format.duration));
            } catch (err) {
                reject(err);
            }
        });
    });
};

(async () => {
    // 進捗計算のために動画の長さを取得
    const duration = await getDuration(input);
    // 音声ストリーム構成 (実ストリーム数・二カ国語判定) を実際にデコードして判定する。
    // EPG由来のメタデータ (AUDIOCOMPONENTTYPE) は誤りや欠落があり得るため信頼しない。
    const plan = await audioTrackPlan(ffprobe, ffmpeg, input);

    const args = ['-y'];
    // 字幕用
    Array.prototype.push.apply(args, ['-fix_sub_duration']);
    // NVidia GPU
    if (USE_GPU) {
        Array.prototype.push.apply(args, ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']);
    }
    // input 設定
    Array.prototype.push.apply(args, ['-i', input]);
    // 音声ストリーム分割 (二カ国語放送の場合のみ channelsplit を適用)
    if (plan.filterComplex) {
        Array.prototype.push.apply(args, ['-filter_complex', plan.filterComplex]);
    }
    // ビデオストリーム設定
    Array.prototype.push.apply(args, ['-map', '0:v', '-c:v', USE_GPU ? 'h264_nvenc' : 'libx264']);
    // インターレス解除
    Array.prototype.push.apply(args, ['-vf', USE_GPU ? 'yadif_cuda' : 'yadif']);
    // オーディオストリーム設定
    Array.prototype.push.apply(args, plan.audioMapArgs);
    if (plan.trackCount > 0) {
        Array.prototype.push.apply(args, ['-c:a', 'aac']);
        if (plan.filterComplex) {
            Array.prototype.push.apply(args, ['-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=eng']);
        }
    }
    // 字幕ストリーム設定
    Array.prototype.push.apply(args, ['-map', '0:s?', '-c:s', 'srt']);
    // 品質設定 (libx264のみ、h264_nvencでは-crfが無効なため)
    if (!USE_GPU) {
        Array.prototype.push.apply(args, ['-preset', 'veryfast', '-crf', '26']);
    }
    // 出力ファイル
    Array.prototype.push.apply(args, [output]);

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
    child.stderr.on('data', data => {
        let strbyline = String(data).split('\n');
        for (let i = 0; i < strbyline.length; i++) {
            let str = strbyline[i];
            if (!str.startsWith('frame')) {
                // non-progress line (version info, errors, stream mapping etc.) — forward to stderr
                if (str !== '') process.stderr.write(str + '\n');
                continue;
            }
            if (str.startsWith('frame')) {
                // 想定log
                // frame= 5159 fps= 11 q=29.0 size=  122624kB time=00:02:51.84 bitrate=5845.8kbits/s dup=19 drop=0 speed=0.372x
                // srcs/ffmpeg (ffmpeg 9) ではサイズの単位が KiB (size=  122624KiB)
                const progress = {};
                const ffmpeg_reg = /frame=\s*(?<frame>\d+)\sfps=\s*(?<fps>\d+(?:\.\d+)?)\sq=\s*(?<q>[+-]?\d+(?:\.\d+)?)\sL?size=\s*(?<size>\d+(?:\.\d+)?)(?:kB|KiB)\stime=\s*(?<time>\d+[:\.\d+]*)\sbitrate=\s*(?<bitrate>\d+(?:\.\d+)?)kbits\/s(?:\sdup=\s*(?<dup>\d+))?(?:\sdrop=\s*(?<drop>\d+))?\sspeed=\s*(?<speed>\d+(?:\.\d+)?)x/;
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
        // MIN_DURATION_RATIO 未満の長さなら失敗として返す
        try {
            const outputDuration = await getDuration(output);
            if (!(outputDuration >= duration * MIN_DURATION_RATIO)) {
                console.error(`enc.js: output is ${outputDuration}s, input is ${duration}s: treating the encode as failed`);
                process.exitCode = 1;
            }
        } catch (err) {
            console.error('enc.js: cannot read the output duration:', err);
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
