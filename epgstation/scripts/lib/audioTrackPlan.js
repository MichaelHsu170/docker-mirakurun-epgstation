const { execFile, spawn } = require('child_process');

// 二カ国語判定は入力の DUAL_MONO_JUDGE_START 秒目から DUAL_MONO_DECODE_SECONDS 秒をデコードして行う。番組の録画の先頭には
// 前の番組の音声が入る (Mirakurun が番組の開始を待つ間に溜めた最大 8 MiB と、EIT の番組切り替えから音声が切り替わるまでの
// 放送局の遅れ。実測で NHK BS 5.3 秒、ヒストリーチャンネル 19.2 秒) ため、先頭で判定すると前の番組の音声で決まる
// (ステレオの後の二カ国語番組が主音声だけになり、二カ国語の後のステレオ番組が左右に分かれる)。60 秒は 8 MiB が 1.5 Mbps でも
// 45 秒、それに遅れの実測の最大 8.6 秒を足しても収まる。それより短い録画は末尾の DUAL_MONO_DECODE_SECONDS 秒で判定する。
// 長さの分からない入力 (ストリームの判定ウィンドウ) は先頭から判定する
const DUAL_MONO_JUDGE_START = 60;
const DUAL_MONO_DECODE_SECONDS = 5;

/**
 * 音声ストリーム数と二カ国語判定 (PCEのdual-mono判定はデコードしないと分からないため
 * 実際に -dual_mono_mode main/sub でデコードして比較する) に基づき、ffmpeg の
 * 音声マッピング引数を組み立てる。
 *
 * - 実音声ストリームが2以上: そのまま全て -map する (既に別個の言語トラックのため
 *   channelsplit 等の加工は不要。加工すると重複/誤ったトラックを生む)
 * - 実音声ストリームが1で二カ国語: channelsplit で2トラックに分離する
 * - 実音声ストリームが1で二カ国語でない: そのまま1トラックとして -map する
 * - 実音声ストリームが0: 音声を一切 map しない
 *
 * firstTrackOnly (ストリーミング用) では実音声ストリームが1以上なら最初の1本 (0:a:0) だけを使う
 * (二カ国語の channelsplit はそのまま)。2本目以降が番組の途中で PMT から消えると (NHK の解説音声は番組終了前に
 * 消える)、ffmpeg 9 はその出力ストリームを待ち続けて全出力を止め、入力をメモリに溜め続けるため。
 *
 * @param {string} ffprobePath
 * @param {string} ffmpegPath
 * @param {string} inputPath ローカルファイルパス (シーク可能であること)
 * @param {string[]} [inputArgs] ffprobe/ffmpeg の入力オプション (-i の前に付ける。-analyzeduration など)
 * @param {boolean} [firstTrackOnly] 最初の実音声ストリームだけを使う
 * @param {number} [inputDuration] 入力の長さ (秒)。分かれば番組の中の音声で二カ国語を判定する (DUAL_MONO_JUDGE_START)
 * @returns {Promise<{filterComplex: string|null, audioMapArgs: string[], trackCount: number}>}
 */
async function audioTrackPlan(ffprobePath, ffmpegPath, inputPath, inputArgs = [], firstTrackOnly = false, inputDuration = 0) {
    const audioStreams = await getAudioStreamCount(ffprobePath, inputPath, inputArgs);
    const audioMap = firstTrackOnly ? '0:a:0' : '0:a';

    if (audioStreams === 0) {
        return { filterComplex: null, audioMapArgs: [], trackCount: 0 };
    }

    if (audioStreams >= 2) {
        return { filterComplex: null, audioMapArgs: ['-map', audioMap], trackCount: firstTrackOnly ? 1 : audioStreams };
    }

    // 0 以下 (長さが分からない NaN も) なら先頭から判定する
    const judgeStart = Math.min(DUAL_MONO_JUDGE_START, inputDuration - DUAL_MONO_DECODE_SECONDS);
    const isDualMono = await checkDualMono(ffmpegPath, inputPath, inputArgs, judgeStart);
    if (!isDualMono) {
        return { filterComplex: null, audioMapArgs: ['-map', audioMap], trackCount: 1 };
    }

    return {
        filterComplex:
            '[0:a:0]channelsplit=channel_layout=stereo[FL0][FR0];' +
            '[FL0]aformat=channel_layouts=mono[FL];[FR0]aformat=channel_layouts=mono[FR]',
        audioMapArgs: ['-map', '[FL]', '-map', '[FR]'],
        trackCount: 2,
    };
}

/**
 * @param {string} ffprobePath
 * @param {string} inputPath
 * @param {string[]} [inputArgs] 入力オプション
 * @return {Promise<number>}
 */
function getAudioStreamCount(ffprobePath, inputPath, inputArgs = []) {
    return new Promise((resolve, reject) => {
        execFile(
            ffprobePath,
            ['-v', 'error', ...inputArgs, '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'json', inputPath],
            (err, stdout) => {
                if (err) {
                    reject(err);
                    return;
                }
                try {
                    const result = JSON.parse(stdout);
                    resolve((result.streams || []).length);
                } catch (e) {
                    reject(e);
                }
            },
        );
    });
}

/**
 * 最初の実音声ストリームを -dual_mono_mode main / sub でそれぞれ judgeStart 秒目から数秒デコードし、
 * 結果が異なれば二カ国語放送と判定する。
 * @param {string} ffmpegPath
 * @param {string} inputPath
 * @param {string[]} inputArgs 入力オプション
 * @param {number} judgeStart デコードを始める位置 (秒)
 * @return {Promise<boolean>}
 */
async function checkDualMono(ffmpegPath, inputPath, inputArgs, judgeStart) {
    const [main, sub] = await Promise.all([
        decodeAudio(ffmpegPath, inputPath, 'main', inputArgs, judgeStart),
        decodeAudio(ffmpegPath, inputPath, 'sub', inputArgs, judgeStart),
    ]);

    return !main.equals(sub);
}

/**
 * @param {string} ffmpegPath
 * @param {string} inputPath
 * @param {'main'|'sub'} mode
 * @param {string[]} inputArgs 入力オプション
 * @param {number} judgeStart デコードを始める位置 (秒。0 以下か NaN なら先頭)
 * @return {Promise<Buffer>} judgeStart 秒目から DUAL_MONO_DECODE_SECONDS 秒の PCM (s16le)
 */
function decodeAudio(ffmpegPath, inputPath, mode, inputArgs, judgeStart) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-dual_mono_mode', mode,
            ...inputArgs,
            ...(judgeStart > 0 ? ['-ss', String(judgeStart)] : []),
            '-i', inputPath,
            '-map', '0:a:0',
            '-t', String(DUAL_MONO_DECODE_SECONDS),
            '-f', 's16le',
            '-',
        ];
        const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        const chunks = [];

        child.stdout.on('data', chunk => chunks.push(chunk));
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) {
                reject(new Error(`ffmpeg exited with code ${code} (dual_mono_mode=${mode})`));
                return;
            }
            resolve(Buffer.concat(chunks));
        });
    });
}

module.exports = { audioTrackPlan, getAudioStreamCount };
