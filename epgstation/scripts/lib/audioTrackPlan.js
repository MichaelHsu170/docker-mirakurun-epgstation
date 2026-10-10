const { execFile, spawn } = require('child_process');

// 二カ国語判定は先頭 DUAL_MONO_DECODE_SECONDS 秒をデコードし、その末尾 DUAL_MONO_JUDGE_SECONDS 秒で行う。
// 録画の先頭には前の番組の音声が 1 秒余り入ることがある (EIT の番組切り替えが音声の切り替えより 0.9-1.4 秒
// 先に来る) ため、先頭の 2 秒は判定に使わない (前の番組の二カ国語で、ステレオの番組全体を左右に分けないように)。
// デコードできた音声が DUAL_MONO_DECODE_SECONDS より短い場合 (ストリームの数秒の判定ウィンドウ) も、その末尾で判定する
const DUAL_MONO_DECODE_SECONDS = 5;
const DUAL_MONO_JUDGE_SECONDS = 3;
// 判定のデコード出力 (s16le, 48 kHz, 2 ch) の 1 秒あたりのバイト数
const PCM_BYTES_PER_SECOND = 48000 * 2 * 2;

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
 * @returns {Promise<{filterComplex: string|null, audioMapArgs: string[], trackCount: number}>}
 */
async function audioTrackPlan(ffprobePath, ffmpegPath, inputPath, inputArgs = [], firstTrackOnly = false) {
    const audioStreams = await getAudioStreamCount(ffprobePath, inputPath, inputArgs);
    const audioMap = firstTrackOnly ? '0:a:0' : '0:a';

    if (audioStreams === 0) {
        return { filterComplex: null, audioMapArgs: [], trackCount: 0 };
    }

    if (audioStreams >= 2) {
        return { filterComplex: null, audioMapArgs: ['-map', audioMap], trackCount: firstTrackOnly ? 1 : audioStreams };
    }

    const isDualMono = await checkDualMono(ffmpegPath, inputPath, inputArgs);
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
 * 最初の実音声ストリームを -dual_mono_mode main / sub でそれぞれ数秒デコードし、
 * 末尾 DUAL_MONO_JUDGE_SECONDS 秒の結果が異なれば二カ国語放送と判定する。
 * @param {string} ffmpegPath
 * @param {string} inputPath
 * @param {string[]} inputArgs 入力オプション
 * @return {Promise<boolean>}
 */
async function checkDualMono(ffmpegPath, inputPath, inputArgs) {
    const [main, sub] = await Promise.all([
        decodeAudio(ffmpegPath, inputPath, 'main', inputArgs),
        decodeAudio(ffmpegPath, inputPath, 'sub', inputArgs),
    ]);
    const judgeBytes = DUAL_MONO_JUDGE_SECONDS * PCM_BYTES_PER_SECOND;

    return !main.subarray(-judgeBytes).equals(sub.subarray(-judgeBytes));
}

/**
 * @param {string} ffmpegPath
 * @param {string} inputPath
 * @param {'main'|'sub'} mode
 * @param {string[]} inputArgs 入力オプション
 * @return {Promise<Buffer>} 先頭 DUAL_MONO_DECODE_SECONDS 秒の PCM (s16le, 48 kHz, 2 ch)
 */
function decodeAudio(ffmpegPath, inputPath, mode, inputArgs) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-dual_mono_mode', mode,
            ...inputArgs,
            '-i', inputPath,
            '-map', '0:a:0',
            '-t', String(DUAL_MONO_DECODE_SECONDS),
            '-f', 's16le',
            '-ac', '2',
            '-ar', '48000',
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
