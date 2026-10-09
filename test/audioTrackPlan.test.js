const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFakeTools } = require('./fakeTools.js');
const { audioTrackPlan } = require('../epgstation/scripts/lib/audioTrackPlan.js');

/** Runs audioTrackPlan with the fakes of fakeTools.js (the options in tools) and the given input options. */
const plan = async (t, tools, inputArgs) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-track-plan-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { ffmpeg, ffprobe } = writeFakeTools(dir, tools);

    return audioTrackPlan(ffprobe, ffmpeg, path.join(dir, 'in.m2ts'), inputArgs);
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

test('maps every audio stream when there are several, without checking for dual mono', async t => {
    // a failing dual-mono check would reject: it must not run
    assert.deepStrictEqual(await plan(t, { audioStreams: 2, dualMono: 'fail' }), {
        filterComplex: null,
        audioMapArgs: ['-map', '0:a'],
        trackCount: 2,
    });
});

test('rejects when the dual-mono check cannot decode the audio', async t => {
    await assert.rejects(plan(t, { audioStreams: 1, dualMono: 'fail' }), /ffmpeg exited with code 1 \(dual_mono_mode=(main|sub)\)/);
});

test('puts the input options before the input in every probe and decode', async t => {
    assert.deepStrictEqual(await callsOf(t, ['-analyzeduration', '7M']), [
        'ffmpeg -v error -dual_mono_mode main -analyzeduration 7M -i in.m2ts -map 0:a:0 -t 5 -f wav -',
        'ffmpeg -v error -dual_mono_mode sub -analyzeduration 7M -i in.m2ts -map 0:a:0 -t 5 -f wav -',
        'ffprobe -v error -analyzeduration 7M -select_streams a -show_entries stream=index -of json in.m2ts',
    ]);
});

test('adds no input options when none are given', async t => {
    assert.deepStrictEqual(await callsOf(t), [
        'ffmpeg -v error -dual_mono_mode main -i in.m2ts -map 0:a:0 -t 5 -f wav -',
        'ffmpeg -v error -dual_mono_mode sub -i in.m2ts -map 0:a:0 -t 5 -f wav -',
        'ffprobe -v error -select_streams a -show_entries stream=index -of json in.m2ts',
    ]);
});

test('rejects when ffprobe fails', async t => {
    await assert.rejects(plan(t, { audioStreams: 1, inputDuration: 'fail' }));
});
