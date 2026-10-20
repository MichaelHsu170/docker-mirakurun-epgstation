const { execFile, spawn } = require('child_process');

// 二カ国語判定は入力の DUAL_MONO_JUDGE_START 秒目から DUAL_MONO_DECODE_SECONDS 秒をデコードして行う。番組の録画の先頭には
// 前の番組の音声が入る (Mirakurun が番組の開始を待つ間に溜めた最大 8 MiB と、EIT の番組切り替えから音声が切り替わるまでの
// 放送局の遅れ。実測で NHK BS 5.3 秒、ヒストリーチャンネル 19.2 秒) ため、先頭で判定すると前の番組の音声で決まる
// (ステレオの後の二カ国語番組が主音声だけになり、二カ国語の後のステレオ番組が左右に分かれる)。60 秒は 8 MiB が 1.5 Mbps でも
// 45 秒、それに遅れの実測の最大 8.6 秒を足しても収まる。それより短い録画は末尾の DUAL_MONO_DECODE_SECONDS 秒で判定する。
// ストリームの判定ウィンドウ (長さ 0) は先頭から、長さの分からない録画 (NaN) は長い録画と同じく 60 秒目から判定する。番組の映像の大きさ (programVideoSize) も同じ区間で判定する。
// 音声ストリームが2以上の録画は、同じ区間にパケットのあるストリームを番組の音声とする (前の番組の2本目の音声は
// 前の番組の部分にしかなく、map すると番組の間は空のトラックになり、ffmpeg 9 はそれを待って入力をメモリに溜め続ける)。
// 映像も同じ区間にフレームのあるストリームを番組の映像とする。どちらも ffprobe の programs (pmtStreamIndexes) にない
// ストリームは除く: サブチャンネル (NHK BS 102、BS日テレ 142、tvk2 など) はメインチャンネルとの同時放送の間はその PID を
// 使い、自分の番組では自分の PID に移る (Mirakurun は PMT から消えた PID を止める)。字幕は番組の映像より後の番号の
// ストリームとする (programSubtitleStreams)
const DUAL_MONO_JUDGE_START = 60;
const DUAL_MONO_DECODE_SECONDS = 5;

// ストリーム検出の入力オプション。既定 (5 MB, BS で約 2 秒分) では、PMT にあってもデータの始まりが遅い
// 音声 (副音声など) が見つからず、srcs/ffmpeg ではそのストリームが破棄されて出力から黙って欠ける
// (映像も: サブチャンネルの録画の、番組の始めに移る自分の PID の映像は map できない)。
// 入力はシーク可能な録画ファイルなので先頭 30 秒分まで探す (200 MB は BS の最大ビットレート
// 約 24 Mbps でも 60 秒分以上あり、30 秒より先に打ち切られない)
const PROBE_ARGS = ['-analyzeduration', '30M', '-probesize', '200M'];

/**
 * 音声ストリーム数と二カ国語判定 (PCEのdual-mono判定はデコードしないと分からないため
 * 実際に -dual_mono_mode main/sub でデコードして比較する) に基づき、ffmpeg の
 * 音声マッピング引数を組み立てる。
 *
 * - 実音声ストリームが2以上: そのまま全て -map する (既に別個の言語トラックのため
 *   channelsplit 等の加工は不要。加工すると重複/誤ったトラックを生む)。ただし長さが分かれば判定区間に
 *   パケットがあり ffprobe の programs にあるストリームだけを使う (無ければ全て)。それが1本なら以下の1本の場合と同じ
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

    const judgeStart = programJudgeStart(inputDuration);

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
 * 番組の中を判定する位置 (秒): DUAL_MONO_JUDGE_START、それより短い録画は末尾の DUAL_MONO_DECODE_SECONDS 秒の始まり。
 * 0 以下 (ストリーム) なら先頭から判定する。長さが分からない録画 (NaN: サブチャンネルの録画が番組の PID に切り替わった後に
 * 放送の時刻が一巡すると ffprobe は長さを出さない) は長い録画として扱う (先頭は前の番組のことがある)
 * @param {number} inputDuration 入力の長さ (秒)
 * @return {number}
 */
function programJudgeStart(inputDuration) {
    return Number.isNaN(inputDuration) ? DUAL_MONO_JUDGE_START : Math.min(DUAL_MONO_JUDGE_START, inputDuration - DUAL_MONO_DECODE_SECONDS);
}

/**
 * ffprobe の JSON 出力 (-show_entries ...:program_stream=index) の programs にあるストリーム番号のうち -select_streams で
 * 選んだもの。読んだ区間の PMT のストリームとは限らない (review D22-2): BS日テレ 142 の録画では、前の版の PMT の映像と
 * 字幕も残っていた (同時放送から自分の番組へも、その逆も)。逆の切り替えの録画では前の PMT の音声は残らず、ffprobe が
 * 判定区間に出す前の番組の音声の古いパケット (先頭 6 秒で終わった音声の 2 パケット) をこれで除く。
 * @param {object} result ffprobe の JSON 出力
 * @return {Set<number>|null} 1つもなければ null (絞り込まない)
 */
function pmtStreamIndexes(result) {
    const indexes = (result.programs || []).flatMap(program => (program.streams || []).map(stream => stream.index));
    return indexes.length === 0 ? null : new Set(indexes);
}

/**
 * 番組の映像: 音声と同じ判定区間 (programJudgeStart から DUAL_MONO_DECODE_SECONDS 秒) にフレームがあり、
 * ffprobe の programs (pmtStreamIndexes) にある映像ストリームと、その最初の (SAR の分かる) フレームの幅、高さ、SAR。
 * 録画の先頭の前の番組の部分は、番組と大きさが違うことがある (1080i と 480i を切り替える NHK BS 102、tvk2 などの
 * サブチャンネル)。前の番組の部分にしかない映像ストリーム (サブチャンネルの番組の前のメインチャンネルの PID) は含まない。
 * read_intervals の + は入力の先頭からの位置 (付けないと放送のタイムスタンプそのものになる)
 * @param {string} ffprobePath
 * @param {string} inputPath
 * @param {string[]} inputArgs 入力オプション
 * @param {number} inputDuration 入力の長さ (秒)
 * @param {AbortSignal} [signal] abort されると ffprobe を SIGKILL で止める (Promise は reject される)
 * @param {number} [judgeStart] 判定区間の始まり (秒)。既定は programJudgeStart(inputDuration)
 * @return {Promise<{width: number, height: number, sar: string, streams: number[], leadInSeconds: number}|null>}
 *   sar は "4/3" の形。streams は入力内のストリーム番号 (小さい順)。leadInSeconds は最初の映像の始まりから番組の映像の
 *   始まりまでの秒数 (前の番組の映像が別のストリームの録画で、その部分はエンコードされない。それ以外は 0)。
 *   判定区間に SAR の分かるフレームがなければ null
 */
function programVideoSize(ffprobePath, inputPath, inputArgs, inputDuration, signal, judgeStart = programJudgeStart(inputDuration)) {
    return new Promise((resolve, reject) => {
        execFile(
            ffprobePath,
            [
                '-v', 'error',
                ...inputArgs,
                '-read_intervals', `+${judgeStart > 0 ? judgeStart : 0}%+${DUAL_MONO_DECODE_SECONDS}`,
                '-select_streams', 'v',
                '-show_entries', 'frame=stream_index,width,height,sample_aspect_ratio:program_stream=index:stream=index,start_time',
                '-of', 'json',
                inputPath,
            ],
            { signal, killSignal: 'SIGKILL' },
            (err, stdout) => {
                if (err) {
                    reject(err);
                    return;
                }
                try {
                    const result = JSON.parse(stdout);
                    const pmt = pmtStreamIndexes(result);
                    const frames = (result.frames || []).filter(frame => pmt === null || pmt.has(frame.stream_index));
                    // SAR の分からないフレームには sample_aspect_ratio がない (csv では "N/A")
                    const frame = frames.find(f => /^[1-9]\d*:[1-9]\d*$/.test(f.sample_aspect_ratio));
                    if (frame === undefined) {
                        resolve(null);
                        return;
                    }
                    const streams = [...new Set(frames.map(f => f.stream_index))].sort((a, b) => a - b);
                    // 映像ストリームの始まり (秒。分からないものは除く)
                    const startOf = indexes =>
                        Math.min(...(result.streams || []).filter(st => indexes === null || indexes.includes(st.index)).map(st => parseFloat(st.start_time)).filter(Number.isFinite));
                    const leadInSeconds = startOf(streams) - startOf(null);
                    resolve({
                        width: frame.width,
                        height: frame.height,
                        sar: frame.sample_aspect_ratio.replace(':', '/'),
                        streams,
                        leadInSeconds: leadInSeconds > 0 ? leadInSeconds : 0,
                    });
                } catch (e) {
                    reject(e);
                }
            },
        );
    });
}

/**
 * 番組の字幕: 番組の映像 (programVideoSize の streams の最初) より後の番号の字幕ストリーム。ffmpeg は PMT にある
 * ストリームに PMT の順 (映像が最初) に番号を付け、PMT が変わって加わったストリームにはその後の番号を付けるため、
 * サブチャンネルの録画の先頭のメインチャンネルの字幕 (番組の映像より前の PMT にある別の PID) は番組の映像より前の
 * 番号になり、含まない。それ以外の録画では全ての字幕。
 * 判定区間にパケットのある字幕は使えない (字幕のない番組の字幕ストリームにはパケットがなく、それだけ外すと
 * 普通の録画の出力も変わる)。ffprobe の programs は前の PMT の字幕も持つ。PID の並び (BS日テレ 142 の 0x240 と 0x245) も使えない (NHK は映像 0x100 と字幕 0x130、
 * CS は 0x100c と 0x120c)
 * @param {string} ffprobePath
 * @param {string} inputPath
 * @param {string[]} inputArgs 入力オプション
 * @param {number} [videoStream] 番組の映像のストリーム番号 (分からなければ全ての字幕)
 * @return {Promise<number[]|null>} 入力内のストリーム番号 (小さい順)。字幕ストリームがなければ null
 */
function programSubtitleStreams(ffprobePath, inputPath, inputArgs, videoStream = -1) {
    return new Promise((resolve, reject) => {
        execFile(
            ffprobePath,
            ['-v', 'error', ...inputArgs, '-select_streams', 's', '-show_entries', 'stream=index', '-of', 'json', inputPath],
            (err, stdout) => {
                if (err) {
                    reject(err);
                    return;
                }
                try {
                    const indexes = (JSON.parse(stdout).streams || []).map(stream => stream.index);
                    resolve(indexes.length === 0 ? null : indexes.filter(index => index > videoStream));
                } catch (e) {
                    reject(e);
                }
            },
        );
    });
}

/**
 * 動画長取得関数
 * @param {string} ffprobePath
 * @param {string} filePath ファイルパス
 * @param {string[]} [inputArgs] 入力オプション (録画には PROBE_ARGS: 既定の 5 MB より後に始まるストリーム (サブチャンネルが
 *   番組の始めに移る自分の PID) があると長さが N/A になり、長さの判定がすべて飛ばされる)
 * @param {AbortSignal} [signal] abort されると ffprobe を SIGKILL で止める (Promise は reject される)
 * @return {Promise<number>} 動画長を返す (秒。分からなければ NaN)
 */
function getDuration(ffprobePath, filePath, inputArgs = [], signal) {
    return new Promise((resolve, reject) => {
        execFile(ffprobePath, ['-v', '0', ...inputArgs, '-show_format', '-of', 'json', filePath], { signal, killSignal: 'SIGKILL' }, (err, stdout) => {
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
 * judgeStart 秒目から DUAL_MONO_DECODE_SECONDS 秒の間にパケットがあり、ffprobe の programs にある音声ストリームを返す。
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
                '-show_entries', 'packet=stream_index:program_stream=index',
                '-of', 'json',
                inputPath,
            ],
            (err, stdout) => {
                if (err) {
                    reject(err);
                    return;
                }
                try {
                    const result = JSON.parse(stdout);
                    const pmt = pmtStreamIndexes(result);
                    resolve(new Set((result.packets || []).map(packet => packet.stream_index).filter(index => pmt === null || pmt.has(index))));
                } catch (e) {
                    reject(e);
                }
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
 * @param {number} judgeStart デコードを始める位置 (秒。0 以下なら先頭)
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

module.exports = { audioTrackPlan, getAudioStreamCount, getDuration, programVideoSize, programSubtitleStreams, PROBE_ARGS };
