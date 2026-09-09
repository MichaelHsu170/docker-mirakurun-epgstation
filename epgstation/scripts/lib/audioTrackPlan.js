const { execFile, spawn } = require('child_process');
const crypto = require('crypto');

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
 * @param {string} ffprobePath
 * @param {string} ffmpegPath
 * @param {string} inputPath ローカルファイルパス (シーク可能であること)
 * @returns {Promise<{filterComplex: string|null, audioMapArgs: string[], trackCount: number}>}
 */
async function audioTrackPlan(ffprobePath, ffmpegPath, inputPath) {
    const audioStreams = await getAudioStreamCount(ffprobePath, inputPath);

    if (audioStreams === 0) {
        return { filterComplex: null, audioMapArgs: [], trackCount: 0 };
    }

    if (audioStreams >= 2) {
        return { filterComplex: null, audioMapArgs: ['-map', '0:a'], trackCount: audioStreams };
    }

    const isDualMono = await checkDualMono(ffmpegPath, inputPath);
    if (!isDualMono) {
        return { filterComplex: null, audioMapArgs: ['-map', '0:a'], trackCount: 1 };
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
 * @return {Promise<number>}
 */
function getAudioStreamCount(ffprobePath, inputPath) {
    return new Promise((resolve, reject) => {
        execFile(
            ffprobePath,
            ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'json', inputPath],
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
 * 結果が異なれば二カ国語放送と判定する。
 * @param {string} ffmpegPath
 * @param {string} inputPath
 * @return {Promise<boolean>}
 */
async function checkDualMono(ffmpegPath, inputPath) {
    const [mainHash, subHash] = await Promise.all([
        decodeAndHash(ffmpegPath, inputPath, 'main'),
        decodeAndHash(ffmpegPath, inputPath, 'sub'),
    ]);

    return mainHash !== subHash;
}

/**
 * @param {string} ffmpegPath
 * @param {string} inputPath
 * @param {'main'|'sub'} mode
 * @return {Promise<string>}
 */
function decodeAndHash(ffmpegPath, inputPath, mode) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-dual_mono_mode', mode,
            '-i', inputPath,
            '-map', '0:a:0',
            '-t', '5',
            '-f', 'wav',
            '-',
        ];
        const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        const hash = crypto.createHash('sha256');

        child.stdout.on('data', chunk => hash.update(chunk));
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) {
                reject(new Error(`ffmpeg exited with code ${code} (dual_mono_mode=${mode})`));
                return;
            }
            resolve(hash.digest('hex'));
        });
    });
}

module.exports = { audioTrackPlan, getAudioStreamCount };
