const { execFile, spawn } = require('child_process');

// 二カ国語判定は入力の DUAL_MONO_JUDGE_START 秒目から DUAL_MONO_DECODE_SECONDS 秒をデコードして行う。番組の録画の先頭には
// 前の番組の音声が入る (Mirakurun が番組の開始を待つ間に溜めた最大 8 MiB と、EIT の番組切り替えから音声が切り替わるまでの
// 放送局の遅れ。実測で NHK BS 5.3 秒、ヒストリーチャンネル 19.2 秒) ため、先頭で判定すると前の番組の音声で決まる
// (ステレオの後の二カ国語番組が主音声だけになり、二カ国語の後のステレオ番組が左右に分かれる)。60 秒は 8 MiB が 1.5 Mbps でも
// 45 秒、それに遅れの実測の最大 8.6 秒を足しても収まる。それより短い録画は末尾の DUAL_MONO_DECODE_SECONDS 秒で判定する。
// 長さの分からない入力 (ストリームの判定ウィンドウ) は先頭から判定する。
// 音声ストリームが2以上の録画は、同じ区間にパケットのあるストリームを番組の音声とする (前の番組の2本目の音声は
// 前の番組の部分にしかなく、map すると番組の間は空のトラックになり、ffmpeg 9 はそれを待って入力をメモリに溜め続ける)
const DUAL_MONO_JUDGE_START = 60;
const DUAL_MONO_DECODE_SECONDS = 5;

/**
 * 音声ストリーム数と二カ国語判定 (PCEのdual-mono判定はデコードしないと分からないため
 * 実際に -dual_mono_mode main/sub でデコードして比較する) に基づき、ffmpeg の
 * 音声マッピング引数を組み立てる。
 *
 * - 実音声ストリームが2以上: そのまま全て -map する (既に別個の言語トラックのため
 *   channelsplit 等の加工は不要。加工すると重複/誤ったトラックを生む)。ただし長さが分かれば判定区間に
 *   パケットのあるストリームだけを使う (無ければ全て)。それが1本なら以下の1本の場合と同じ
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
    const streamIndexes = await getAudioStreamIndexes(ffprobePath, inputPath, inputArgs);
    let audioMapArgs = ['-map', firstTrackOnly ? '0:a:0' : '0:a'];
    let audioStreams = streamIndexes.length;
    // 二カ国語判定と channelsplit をする音声 (0:a:N の N)
    let firstTrack = 0;

    if (audioStreams === 0) {
        return { filterComplex: null, audioMapArgs: [], trackCount: 0 };
    }

    // 0 以下 (長さが分からない NaN も) なら先頭から判定する
    const judgeStart = Math.min(DUAL_MONO_JUDGE_START, inputDuration - DUAL_MONO_DECODE_SECONDS);

    if (audioStreams >= 2 && !firstTrackOnly && judgeStart > 0) {
        const withPackets = await getAudioStreamsWithPackets(ffprobePath, inputPath, inputArgs, judgeStart);
        const tracks = streamIndexes.map((_, n) => n).filter(n => withPackets.has(streamIndexes[n]));
        if (tracks.length > 0 && tracks.length < audioStreams) {
            audioMapArgs = tracks.flatMap(n => ['-map', `0:a:${n}`]);
            audioStreams = tracks.length;
            firstTrack = tracks[0];
        }
    }

    if (audioStreams >= 2) {
        return { filterComplex: null, audioMapArgs, trackCount: firstTrackOnly ? 1 : audioStreams };
    }

    const isDualMono = await checkDualMono(ffmpegPath, inputPath, inputArgs, judgeStart, firstTrack);
    if (!isDualMono) {
        return { filterComplex: null, audioMapArgs, trackCount: 1 };
    }

    return {
        filterComplex:
            `[0:a:${firstTrack}]channelsplit=channel_layout=stereo[FL0][FR0];` +
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
async function getAudioStreamCount(ffprobePath, inputPath, inputArgs = []) {
    return (await getAudioStreamIndexes(ffprobePath, inputPath, inputArgs)).length;
}

/**
 * @param {string} ffprobePath
 * @param {string} inputPath
 * @param {string[]} inputArgs 入力オプション
 * @return {Promise<number[]>} 音声ストリームの入力内のストリーム番号 (0:a:N の順)
 */
function getAudioStreamIndexes(ffprobePath, inputPath, inputArgs) {
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
                    resolve((result.streams || []).map(stream => stream.index));
                } catch (e) {
                    reject(e);
                }
            },
        );
    });
}

/**
 * judgeStart 秒目から DUAL_MONO_DECODE_SECONDS 秒の間にパケットのある音声ストリームを返す。
 * read_intervals の + は入力の先頭からの位置 (付けないと放送のタイムスタンプそのものになる)
 * @param {string} ffprobePath
 * @param {string} inputPath
 * @param {string[]} inputArgs 入力オプション
 * @param {number} judgeStart 位置 (秒)
 * @return {Promise<Set<number>>} 入力内のストリーム番号
 */
function getAudioStreamsWithPackets(ffprobePath, inputPath, inputArgs, judgeStart) {
    return new Promise((resolve, reject) => {
        execFile(
            ffprobePath,
            [
                '-v', 'error',
                ...inputArgs,
                '-read_intervals', `+${judgeStart}%+${DUAL_MONO_DECODE_SECONDS}`,
                '-select_streams', 'a',
                '-show_entries', 'packet=stream_index',
                '-of', 'csv=p=0',
                inputPath,
            ],
            (err, stdout) => {
                if (err) {
                    reject(err);
                    return;
                }
                // 1パケット1行 ("1," のように区切りが付く)
                resolve(new Set(stdout.split('\n').filter(line => line !== '').map(line => parseInt(line, 10))));
            },
        );
    });
}

/**
 * 実音声ストリーム track を -dual_mono_mode main / sub でそれぞれ judgeStart 秒目から数秒デコードし、
 * 結果が異なれば二カ国語放送と判定する。
 * @param {string} ffmpegPath
 * @param {string} inputPath
 * @param {string[]} inputArgs 入力オプション
 * @param {number} judgeStart デコードを始める位置 (秒)
 * @param {number} track 判定する音声 (0:a:N の N)
 * @return {Promise<boolean>}
 */
async function checkDualMono(ffmpegPath, inputPath, inputArgs, judgeStart, track) {
    const [main, sub] = await Promise.all([
        decodeAudio(ffmpegPath, inputPath, 'main', inputArgs, judgeStart, track),
        decodeAudio(ffmpegPath, inputPath, 'sub', inputArgs, judgeStart, track),
    ]);

    return !main.equals(sub);
}

/**
 * @param {string} ffmpegPath
 * @param {string} inputPath
 * @param {'main'|'sub'} mode
 * @param {string[]} inputArgs 入力オプション
 * @param {number} judgeStart デコードを始める位置 (秒。0 以下か NaN なら先頭)
 * @param {number} track デコードする音声 (0:a:N の N)
 * @return {Promise<Buffer>} judgeStart 秒目から DUAL_MONO_DECODE_SECONDS 秒の PCM (s16le)
 */
function decodeAudio(ffmpegPath, inputPath, mode, inputArgs, judgeStart, track) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-dual_mono_mode', mode,
            ...inputArgs,
            ...(judgeStart > 0 ? ['-ss', String(judgeStart)] : []),
            '-i', inputPath,
            '-map', `0:a:${track}`,
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
