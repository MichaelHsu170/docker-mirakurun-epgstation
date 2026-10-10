const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFakeTools } = require('./fakeTools.js');
const { audioTrackPlan } = require('../epgstation/scripts/lib/audioTrackPlan.js');

/** Runs audioTrackPlan with the fakes of fakeTools.js (the options in tools) and the given input options. */
const plan = async (t, tools, inputArgs, firstTrackOnly) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-track-plan-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { ffmpeg, ffprobe } = writeFakeTools(dir, tools);

    return audioTrackPlan(ffprobe, ffmpeg, path.join(dir, 'in.m2ts'), inputArgs, firstTrackOnly);
};

/** The calls of the fakes while audioTrackPlan runs with the given input options, sorted */
const callsOf = async (t, inputArgs) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-track-plan-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const callLog = path.join(dir, 'calls');
    const { ffmpeg, ffprobe } = writeFakeTools(dir, { audioStreams: 1, callLog });
    await audioTrackPlan(ffprobe, ffmpeg, 'in.m2ts', inputArgs);

    return fs.readFileSync(callLog, 'utf8').trimEnd().split('\n').sort();
};

test('maps no audio when there is no audio stream', async t => {
    assert.deepStrictEqual(await plan(t, { audioStreams: 0 }), { filterComplex: null, audioMapArgs: [], trackCount: 0 });
});

test('maps one audio stream that is not dual mono as it is', async t => {
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: false }), {
        filterComplex: null,
        audioMapArgs: ['-map', '0:a'],
        trackCount: 1,
    });
});

test('splits one dual-mono audio stream into two tracks', async t => {
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: true }), {
        filterComplex:
            '[0:a:0]channelsplit=channel_layout=stereo[FL0][FR0];' +
            '[FL0]aformat=channel_layouts=mono[FL];[FR0]aformat=channel_layouts=mono[FR]',
        audioMapArgs: ['-map', '[FL]', '-map', '[FR]'],
        trackCount: 2,
    });
});

const SPLIT = {
    filterComplex:
        '[0:a:0]channelsplit=channel_layout=stereo[FL0][FR0];' +
        '[FL0]aformat=channel_layouts=mono[FL];[FR0]aformat=channel_layouts=mono[FR]',
    audioMapArgs: ['-map', '[FL]', '-map', '[FR]'],
    trackCount: 2,
};
const NO_SPLIT = { filterComplex: null, audioMapArgs: ['-map', '0:a'], trackCount: 1 };

// a recording starts at the EIT switch, which came 0.86-1.43 s before the audio change at NHK G (review D11-2)
test('does not split a stereo recording that starts with 1.4 s of the previous program\'s dual mono', async t => {
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: [[1.4, true], [60, false]] }), NO_SPLIT);
});

test('splits a dual-mono recording that starts with 1.4 s of the previous program\'s stereo', async t => {
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: [[1.4, false], [60, true]] }), SPLIT);
});

test('judges dual mono on the last 3 of the first 5 s: a lead-in of 1.9 s is ignored, one of 2.1 s is not', async t => {
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: [[1.9, true], [60, false]] }), NO_SPLIT);
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: [[2.1, true], [60, false]] }), SPLIT);
});

test('does not split audio that turns dual mono only after the first 5 s', async t => {
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: [[5.5, false], [60, true]] }), NO_SPLIT);
});

test('still splits dual mono in a probe window shorter than 5 s, as a live stream\'s 2-3 s window', async t => {
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: [[2, true]] }, [], true), SPLIT);
    // the last 3 s of a 4 s window: the dual mono of its first second is ignored
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: [[1, true], [3, false]] }, [], true), {
        ...NO_SPLIT,
        audioMapArgs: ['-map', '0:a:0'],
    });
});

test('maps every audio stream when there are several, without checking for dual mono', async t => {
    // a failing dual-mono check would reject: it must not run
    assert.deepStrictEqual(await plan(t, { audioStreams: 2, dualMono: 'fail' }), {
        filterComplex: null,
        audioMapArgs: ['-map', '0:a'],
        trackCount: 2,
    });
});

test('maps only the first of several audio streams for a stream, without checking for dual mono', async t => {
    // a 2nd audio stream that leaves the PMT mid-program stalls every output of ffmpeg 9
    assert.deepStrictEqual(await plan(t, { audioStreams: 2, dualMono: 'fail' }, [], true), {
        filterComplex: null,
        audioMapArgs: ['-map', '0:a:0'],
        trackCount: 1,
    });
});

test('maps only the first audio stream for a stream when it is not dual mono', async t => {
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: false }, [], true), {
        filterComplex: null,
        audioMapArgs: ['-map', '0:a:0'],
        trackCount: 1,
    });
});

test('still splits a dual-mono audio stream into two tracks for a stream', async t => {
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: true }, [], true), {
        filterComplex:
            '[0:a:0]channelsplit=channel_layout=stereo[FL0][FR0];' +
            '[FL0]aformat=channel_layouts=mono[FL];[FR0]aformat=channel_layouts=mono[FR]',
        audioMapArgs: ['-map', '[FL]', '-map', '[FR]'],
        trackCount: 2,
    });
});

test('maps no audio for a stream when there is no audio stream', async t => {
    assert.deepStrictEqual(await plan(t, { audioStreams: 0 }, [], true), { filterComplex: null, audioMapArgs: [], trackCount: 0 });
});

test('rejects when the dual-mono check cannot decode the audio', async t => {
    await assert.rejects(plan(t, { audioStreams: 1, dualMono: 'fail' }), /ffmpeg exited with code 1 \(dual_mono_mode=(main|sub)\)/);
});

test('puts the input options before the input in every probe and decode', async t => {
    assert.deepStrictEqual(await callsOf(t, ['-analyzeduration', '7M']), [
        'ffmpeg -v error -dual_mono_mode main -analyzeduration 7M -i in.m2ts -map 0:a:0 -t 5 -f s16le -ac 2 -ar 48000 -',
        'ffmpeg -v error -dual_mono_mode sub -analyzeduration 7M -i in.m2ts -map 0:a:0 -t 5 -f s16le -ac 2 -ar 48000 -',
        'ffprobe -v error -analyzeduration 7M -select_streams a -show_entries stream=index -of json in.m2ts',
    ]);
});

test('adds no input options when none are given', async t => {
    assert.deepStrictEqual(await callsOf(t), [
        'ffmpeg -v error -dual_mono_mode main -i in.m2ts -map 0:a:0 -t 5 -f s16le -ac 2 -ar 48000 -',
        'ffmpeg -v error -dual_mono_mode sub -i in.m2ts -map 0:a:0 -t 5 -f s16le -ac 2 -ar 48000 -',
        'ffprobe -v error -select_streams a -show_entries stream=index -of json in.m2ts',
    ]);
});

test('rejects when ffprobe fails', async t => {
    await assert.rejects(plan(t, { audioStreams: 1, inputDuration: 'fail' }));
});
