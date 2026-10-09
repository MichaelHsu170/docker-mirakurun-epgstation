const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFakeTools } = require('./fakeTools.js');
const { audioTrackPlan } = require('../epgstation/scripts/lib/audioTrackPlan.js');

/** Runs audioTrackPlan with the fakes of fakeTools.js (the options in tools). */
const plan = async (t, tools) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-track-plan-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { ffmpeg, ffprobe } = writeFakeTools(dir, tools);

    return audioTrackPlan(ffprobe, ffmpeg, path.join(dir, 'in.m2ts'));
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

test('rejects when ffprobe fails', async t => {
    await assert.rejects(plan(t, { audioStreams: 1, inputDuration: 'fail' }));
});
