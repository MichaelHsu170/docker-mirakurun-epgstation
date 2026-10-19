const { spawn } = require('child_process');
const path = require('path');
const { getDuration, programVideoSize, PROBE_ARGS } = require('./lib/audioTrackPlan.js');

// config.yml の thumbnailCmd から渡される: thumbnail.js <ffmpegPath> <input> <output> <position> <size>
// (thumbnailCmd では %FFMPEG% と %INPUT% などだけが置換され、環境変数での受け渡しは無い。ffprobe は streamEncode.js と
// 同じく ffmpeg と同じディレクトリにある前提)
const [ffmpeg, input, output, position, size] = process.argv.slice(2);
const ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe');

// EPGStation はサムネイルのコマンドが 10 分 (ThumbnailManageModel の CREATE_TIMEOUT) で終わらなければ SIGKILL するが、
// 止まるのはこのスクリプトだけで、子の ffprobe や ffmpeg は動き続け、ffmpeg は後から出力を書く (DB に行のないファイルが
// 残る)。そのためその前に自分で子を SIGKILL して失敗する (子が動いている間はこのスクリプトも終わらない)
const TIMEOUT_SECONDS = 9 * 60;
const abort = new AbortController();
setTimeout(() => {
    console.error(`thumbnail.js: not finished in ${TIMEOUT_SECONDS} s, stopping`);
    abort.abort();
}, TIMEOUT_SECONDS * 1000).unref();

// 位置は録画の終わりの 1 秒以上前であること。それより後の位置 (短い録画) にはサムネイルを作らない (失敗する): 既定の
// コマンドは、録画より先の位置では最後のキーフレームから探してフレームがなく失敗する (exit 234) が、録画の終わりが
// その I フレームの途中だと、途中までの崩れたフレームを書いて 0 で終わる (実際の録画の切れ目でどちらにもなる)。位置の
// フレームは、それが参照する次のフレーム (0.1 秒以内) まで録画にあれば正しい
const END_MARGIN_SECONDS = 1;

// EPGStation の既定の thumbnailCmd (%FFMPEG% -ss %THUMBNAIL_POSITION% -y -i %INPUT% -vframes 1 -f image2
// -s %THUMBNAIL_SIZE% %OUTPUT%) に、番組の映像を選ぶ引数を足したもの。既定のコマンドでは ffmpeg が一番大きい
// (同じなら番号の小さい) 映像を選ぶため、サブチャンネル (NHK BS 102、BS日テレ 142、tvk2 など) の自分の番組の録画では
// 先頭のメインチャンネルの映像 (別の PID。Mirakurun は番組の切り替えでその PID を止める) を選び、その映像には
// position 秒目のフレームがないため、何も書かずに失敗する (exit 234)。
// 番組の映像は enc.js と同じく録画の 60 秒目 (lib/audioTrackPlan.js の programVideoSize) で決める。長さは渡さない
// (60 秒目からの判定区間にフレームのない録画には、既定のコマンドを使う)。既定の 5 MB の検出では番組の映像は
// map できない (Cannot map stream: unsupported type) ため PROBE_ARGS で開く。番組の映像が見つからないか判定に
// 失敗すると既定のコマンドのまま
(async () => {
    // 分からなければ (NaN) 位置を確かめない
    const duration = await getDuration(ffprobe, input, PROBE_ARGS, abort.signal).catch(() => NaN);
    let videoSize = null;
    try {
        videoSize = await programVideoSize(ffprobe, input, PROBE_ARGS, Infinity, abort.signal);
    } catch (err) {
        console.error('thumbnail.js: cannot find the program video, using the default command:', err);
    }
    if (abort.signal.aborted) {
        process.exitCode = 1;
        return;
    }
    if (duration < Number(position) + END_MARGIN_SECONDS) {
        console.error(`thumbnail.js: the recording (${duration} s) is too short for a thumbnail at ${position} s`);
        process.exitCode = 1;
        return;
    }
    const inputArgs = videoSize === null ? [] : PROBE_ARGS;
    // 番組の映像が複数あれば最初のもの
    const mapArgs = videoSize === null ? [] : ['-map', `0:${videoSize.streams[0]}`];
    const child = spawn(
        ffmpeg,
        [...inputArgs, '-ss', position, '-y', '-i', input, ...mapArgs, '-vframes', '1', '-f', 'image2', '-s', size, output],
        { stdio: 'inherit', signal: abort.signal, killSignal: 'SIGKILL' },
    );
    child.on('error', err => {
        console.error('thumbnail.js: cannot run ffmpeg:', err);
        process.exitCode = 1;
    });
    // シグナルで終了した場合 code は null になる (失敗として返す)
    child.on('close', code => {
        process.exitCode = code === null ? 1 : code;
    });
})();
