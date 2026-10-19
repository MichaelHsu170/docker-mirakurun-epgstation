const { spawn } = require('child_process');
const path = require('path');
const { programVideoSize, PROBE_ARGS } = require('./lib/audioTrackPlan.js');

// config.yml の thumbnailCmd から渡される: thumbnail.js <ffmpegPath> <input> <output> <position> <size>
// (thumbnailCmd では %FFMPEG% と %INPUT% などだけが置換され、環境変数での受け渡しは無い。ffprobe は streamEncode.js と
// 同じく ffmpeg と同じディレクトリにある前提)
const [ffmpeg, input, output, position, size] = process.argv.slice(2);
const ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe');

// EPGStation の既定の thumbnailCmd (%FFMPEG% -ss %THUMBNAIL_POSITION% -y -i %INPUT% -vframes 1 -f image2
// -s %THUMBNAIL_SIZE% %OUTPUT%) に、番組の映像を選ぶ引数を足したもの。既定のコマンドでは ffmpeg が一番大きい
// (同じなら番号の小さい) 映像を選ぶため、サブチャンネル (NHK BS 102、BS日テレ 142、tvk2 など) の自分の番組の録画では
// 先頭のメインチャンネルの映像 (別の PID。Mirakurun は番組の切り替えでその PID を止める) を選び、その映像には
// position 秒目のフレームがないため、何も書かずに失敗する (exit 234)。
// 番組の映像は enc.js と同じく録画の 60 秒目 (lib/audioTrackPlan.js の programVideoSize) で決める。長さは渡さない
// (60 秒目からの判定区間にフレームのない短い録画には、既定のコマンドを使う)。既定の 5 MB の検出では番組の映像は
// map できない (Cannot map stream: unsupported type) ため PROBE_ARGS で開く。番組の映像が見つからないか判定に
// 失敗すると既定のコマンドのまま
(async () => {
    let videoSize = null;
    try {
        videoSize = await programVideoSize(ffprobe, input, PROBE_ARGS, Infinity);
    } catch (err) {
        console.error('thumbnail.js: cannot find the program video, using the default command:', err);
    }
    const inputArgs = videoSize === null ? [] : PROBE_ARGS;
    // 番組の映像が複数あれば最初のもの
    const mapArgs = videoSize === null ? [] : ['-map', `0:${videoSize.streams[0]}`];
    const child = spawn(
        ffmpeg,
        [...inputArgs, '-ss', position, '-y', '-i', input, ...mapArgs, '-vframes', '1', '-f', 'image2', '-s', size, output],
        { stdio: 'inherit' },
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
