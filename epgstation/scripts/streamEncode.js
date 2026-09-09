const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { audioTrackPlan, getAudioStreamCount } = require('./lib/audioTrackPlan.js');

// config.yml の cmd から渡される: streamEncode.js <context> <format> <quality> <ffmpegPath>
// ライブ/録画streamのcmd置換では %FFMPEG% のみが置換され (%FFPROBE% は存在せず、
// enc.js のような env var 経由の受け渡しも無い)、ffprobe は ffmpeg と同じ
// ディレクトリに置かれる前提で自前導出する。
const context = process.argv[2]; // 'live' | 'recorded'
const format = process.argv[3]; // 'm2ts' | 'm2tsll' | 'webm' | 'mp4'
const quality = process.argv[4]; // '720p' | '480p' | '720p_low'
const ffmpeg = process.argv[5];
const ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe');

// pipe:0 は非シーク可能なため、最初の数秒 (or 数MB) をバッファして一時ファイルに書き出し、
// それに対して音声構成を判定してから実際の ffmpeg を起動する。
const PROBE_MAX_MS = 3000;
const PROBE_MAX_BYTES = 6 * 1024 * 1024;

// 実音声ストリームが2以上 (既に分離済み) か0の場合は dual-mono 判定が不要なため、
// そのことをPMT等から判別できる程度の小さいウィンドウだけ先にバッファし、早期に
// ffprobe で確認できればそこで即座にバッファを打ち切る。実音声ストリームが1の場合のみ
// 上記のPROBE_MAX_MS/BYTESまでバッファを継続し、dual-mono判定 (decode-compare) に移る。
const FAST_PROBE_MS = 500;
const FAST_PROBE_BYTES = 512 * 1024;

/**
 * 各フォーマット/画質ごとの ffmpeg 引数テーブル。
 * 音声マッピング (-map / -filter_complex) は audioTrackPlan() の結果を都度差し込むため、
 * ここには含めない。
 */
const PROFILES = {
    live: {
        m2ts: {
            inputArgs: q => ['-re', '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
            extraArgs: () => ['-sn', '-threads', '0'],
            audioArgs: q => ['-c:a', 'aac', '-ar', '48000', '-b:a', q === '480p' ? '128k' : '192k'],
            videoArgs: q => [
                '-c:v', 'h264_nvenc',
                '-vf', `yadif_cuda,scale_cuda=-2:${q === '480p' ? '480' : '720'}`,
                '-b:v', q === '720p' ? '3000k' : '1500k',
            ],
            outputArgs: () => ['-f', 'mpegts'],
        },
        m2tsll: {
            inputArgs: () => ['-f', 'mpegts', '-analyzeduration', '500000'],
            extraArgs: () => [
                '-map', '0:s?', '-map', '0:d?', '-c:s', 'copy', '-c:d', 'copy', '-ignore_unknown',
                '-fflags', 'nobuffer', '-flags', 'low_delay', '-max_delay', '250000', '-max_interleave_delta', '1',
                '-threads', '0',
            ],
            audioArgs: q => ['-c:a', 'aac', '-ar', '48000', '-b:a', q === '480p' ? '128k' : '192k'],
            videoArgs: q => [
                '-c:v', 'libx264', '-flags', '+cgop',
                '-vf', `yadif,scale=-2:${q === '480p' ? '480' : '720'}`,
                '-b:v', q === '720p' ? '3000k' : '1500k',
                '-preset', 'veryfast',
            ],
            outputArgs: () => ['-f', 'mpegts'],
        },
        webm: {
            inputArgs: () => ['-re'],
            extraArgs: q => ['-sn', '-threads', q === '480p' ? '2' : '3'],
            audioArgs: q => ['-c:a', 'libvorbis', '-ar', '48000', '-b:a', q === '480p' ? '128k' : '192k'],
            videoArgs: q => [
                '-c:v', 'libvpx-vp9',
                '-vf', `yadif,scale=-2:${q === '480p' ? '480' : '720'}`,
                '-b:v', q === '720p' ? '3000k' : '1500k',
                '-deadline', 'realtime', '-speed', '4', '-cpu-used', '-8',
            ],
            outputArgs: () => ['-f', 'webm'],
        },
        mp4: {
            inputArgs: () => ['-re'],
            extraArgs: () => ['-sn', '-threads', '0'],
            audioArgs: q => ['-c:a', 'aac', '-ar', '48000', '-b:a', q === '480p' ? '128k' : '192k'],
            videoArgs: q => [
                '-c:v', 'libx264',
                '-vf', `yadif,scale=-2:${q === '480p' ? '480' : '720'}`,
                '-b:v', q === '720p' ? '3000k' : '1500k',
                '-profile:v', 'baseline', '-preset', 'veryfast', '-tune', 'fastdecode,zerolatency',
            ],
            outputArgs: () => ['-movflags', 'frag_keyframe+empty_moov+faststart+default_base_moof', '-f', 'mp4'],
        },
    },
    recorded: {
        webm: {
            inputArgs: () => [],
            extraArgs: () => ['-sn', '-threads', '3'],
            audioArgs: q => ['-c:a', 'libvorbis', '-ar', '48000', '-b:a', q === '480p' ? '128k' : '192k'],
            videoArgs: q => [
                '-c:v', 'libvpx-vp9',
                '-vf', `yadif,scale=-2:${q === '480p' ? '480' : '720'}`,
                '-b:v', q === '720p' ? '3000k' : '1500k',
                '-deadline', 'realtime', '-speed', '4', '-cpu-used', '-8',
            ],
            outputArgs: () => ['-f', 'webm'],
        },
        mp4: {
            inputArgs: () => ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
            extraArgs: () => ['-sn', '-threads', '0'],
            audioArgs: q => ['-c:a', 'aac', '-ar', '48000', '-b:a', q === '480p' ? '128k' : '192k'],
            videoArgs: q => [
                '-c:v', 'h264_nvenc',
                '-vf', `yadif_cuda,scale_cuda=-2:${q === '480p' ? '480' : '720'}`,
                '-b:v', q === '720p' ? '3000k' : '1500k',
                '-profile:v', 'baseline',
            ],
            outputArgs: () => ['-movflags', 'frag_keyframe+empty_moov+faststart+default_base_moof', '-f', 'mp4'],
        },
    },
};

/**
 * stdin の先頭を一時ファイルにバッファする。実音声ストリーム数が1でなければ
 * (0 or 2+) dual-mono 判定自体が不要なため、FAST_PROBE_MS/BYTES 相当の小さい
 * ウィンドウの時点で一度 ffprobe による軽いストリーム数チェックを行い、1でないと
 * 確認できれば即座にバッファを打ち切る (早期リターン)。実音声ストリームが1、または
 * 早期チェックに失敗した場合は、従来通り PROBE_MAX_MS/BYTES まで継続する
 * (dual-mono のdecode-compare判定にはこの長さのサンプルが必要)。
 * @param {string} ffprobePath
 * @return {Promise<{tempFile: string, tailChunks: Buffer[], cleanup: Function}>}
 */
function bufferProbeWindow(ffprobePath) {
    return new Promise((resolve, reject) => {
        const tempFile = path.join(os.tmpdir(), `streamEncode-${process.pid}-${Date.now()}.ts`);
        const out = fs.createWriteStream(tempFile);
        let bytes = 0;
        let flushedBytes = 0;
        let done = false;
        let fastCheckStarted = false;
        const tailChunks = [];
        const timer = setTimeout(finish, PROBE_MAX_MS);
        const fastTimer = setTimeout(maybeRunFastCheck, FAST_PROBE_MS);

        const onData = chunk => {
            if (done) {
                tailChunks.push(chunk);
                return;
            }
            bytes += chunk.length;
            out.write(chunk, () => {
                flushedBytes += chunk.length;
                if (!fastCheckStarted && flushedBytes >= FAST_PROBE_BYTES) {
                    maybeRunFastCheck();
                }
            });
            if (bytes >= PROBE_MAX_BYTES) {
                finish();
            }
        };

        const onEnd = () => finish();

        function cleanup() {
            process.stdin.removeListener('data', onData);
            process.stdin.removeListener('end', onEnd);
        }

        function finish() {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clearTimeout(fastTimer);
            out.end(() => resolve({ tempFile, tailChunks, cleanup }));
        }

        function maybeRunFastCheck() {
            if (fastCheckStarted || done || flushedBytes === 0) {
                return;
            }
            fastCheckStarted = true;
            // この時点でまだ書き込み中のファイルに対して ffprobe を読ませるが、
            // flushedBytes までは write() のコールバックで確認済みのため、
            // ffprobe が目にする内容と矛盾しない。
            getAudioStreamCount(ffprobePath, tempFile)
                .then(count => {
                    // count>=2 (複数の実音声PIDが解決済み) の場合のみ早期確定する。
                    // count===0 はデータ不足で未解決なだけの可能性が高く
                    // (実際は1本のみでもcodecparが未解決だと0と報告されうる)、
                    // count===1 と同様に通常の全量バッファまで継続する。
                    if (!done && count >= 2) {
                        finish();
                    }
                })
                .catch(() => {
                    // 早期チェックに失敗した場合は通常どおり全量バッファまで継続する
                });
        }

        process.stdin.on('data', onData);
        process.stdin.on('end', onEnd);
        process.stdin.on('error', reject);
    });
}

(async () => {
    const profile = (PROFILES[context] || {})[format];
    if (!profile) {
        process.stderr.write(`streamEncode.js: unknown context/format: ${context}/${format}\n`);
        process.exitCode = 1;
        return;
    }

    const { tempFile, tailChunks, cleanup } = await bufferProbeWindow(ffprobe);
    // EPGStation はストリーム停止時にこのプロセスへ直接 SIGTERM を送ることが多く、
    // child.on('close') や stdin の 'end' を経由しない経路で終了する。
    // 'exit' はプロセス終了直前に必ず (SIGKILL以外では) 発火するため、
    // 一時ファイルの掃除はここに一本化する。
    process.on('exit', () => {
        try {
            fs.unlinkSync(tempFile);
        } catch (e) {
            // すでに削除済み、または書き込み中断などは無視してよい
        }
    });

    let plan;
    try {
        plan = await audioTrackPlan(ffprobe, ffmpeg, tempFile);
    } catch (e) {
        process.stderr.write(`streamEncode.js: audioTrackPlan failed: ${e.message}\n`);
        plan = { filterComplex: null, audioMapArgs: ['-map', '0:a?'], trackCount: 1 };
    }

    const args = ['-y'];
    Array.prototype.push.apply(args, profile.inputArgs(quality));
    Array.prototype.push.apply(args, ['-i', 'pipe:0']);
    if (plan.filterComplex) {
        Array.prototype.push.apply(args, ['-filter_complex', plan.filterComplex]);
    }
    Array.prototype.push.apply(args, ['-map', '0:v']);
    Array.prototype.push.apply(args, plan.audioMapArgs);
    Array.prototype.push.apply(args, profile.extraArgs(quality));
    Array.prototype.push.apply(args, profile.videoArgs(quality));
    if (plan.trackCount > 0) {
        Array.prototype.push.apply(args, profile.audioArgs(quality));
        if (plan.filterComplex) {
            Array.prototype.push.apply(args, ['-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=eng']);
        }
    }
    Array.prototype.push.apply(args, profile.outputArgs(quality));
    args.push('pipe:1');

    process.stderr.write('streamEncode.js: ffmpeg command: ' + ffmpeg + ' ' + args.join(' ') + '\n');

    const child = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    // ffmpeg がstdinを閉じた後も process.stdin/tailChunks からの書き込みが続くと
    // EPIPEが発生する。'error' リスナーが無いと未処理例外としてプロセス全体が
    // 落ちてしまうため、ここで明示的に受け止めて child.on('close') 側の終了処理に委ねる。
    child.stdin.on('error', err => {
        console.error('streamEncode.js: child stdin error:', err.message);
    });

    // バッファ済みの先頭データを再生してから、残りの stdin をそのまま中継する。
    // createReadStream().pipe() は非同期のため、完全に書き出し終わるまで
    // tailChunks / 以降の stdin を書き込んではならない (順序が壊れるため)。
    const bufferedReadStream = fs.createReadStream(tempFile);
    bufferedReadStream.on('error', err => {
        console.error('streamEncode.js: failed to read back buffered prefix:', err);
        cleanup();
        child.kill('SIGTERM');
        process.exitCode = 1;
    });
    bufferedReadStream.pipe(child.stdin, { end: false });
    bufferedReadStream.on('end', () => {
        // ここで同期的に listener を外してから pipe() に切り替えるため、
        // onData が tailChunks に追記し続ける (メモリリーク) 隙間は生じない。
        cleanup();
        for (const chunk of tailChunks) {
            child.stdin.write(chunk);
        }
        process.stdin.pipe(child.stdin);
    });
    child.stdout.pipe(process.stdout);
    child.stderr.on('data', data => process.stderr.write(data));

    child.on('error', err => {
        console.error(err);
        process.exitCode = 1;
    });

    child.on('close', code => {
        process.exitCode = code;
    });

    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
})().catch(err => {
    // stdin がバッファリング中に 'error' を発火した場合などはここに到達する。
    // 未処理のまま落ちると原因が分かりにくいため、明示的にログしてから終了する。
    console.error('streamEncode.js: fatal error:', err);
    process.exitCode = 1;
});
