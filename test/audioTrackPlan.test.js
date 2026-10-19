const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFakeTools } = require('./fakeTools.js');
const { audioTrackPlan } = require('../epgstation/scripts/lib/audioTrackPlan.js');

/** Runs audioTrackPlan with the fakes of fakeTools.js (the options in tools) and the given arguments. */
const plan = async (t, tools, inputArgs, firstTrackOnly, inputDuration) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-track-plan-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { ffmpeg, ffprobe } = writeFakeTools(dir, tools);

    return audioTrackPlan(ffprobe, ffmpeg, path.join(dir, 'in.m2ts'), inputArgs, firstTrackOnly, inputDuration);
};

/** The plan of an encode (all tracks) of a recording with the given audio parts ([seconds, isDualMono]) */
const recordingPlan = (t, parts) =>
    plan(t, { audioStreams: 1, dualMono: parts }, [], false, parts.reduce((sum, [seconds]) => sum + seconds, 0));

/** The calls of the fakes while audioTrackPlan runs with the given input options and duration, sorted */
const callsOf = async (t, inputArgs, inputDuration) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-track-plan-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const callLog = path.join(dir, 'calls');
    const { ffmpeg, ffprobe } = writeFakeTools(dir, { audioStreams: 1, callLog });
    await audioTrackPlan(ffprobe, ffmpeg, 'in.m2ts', inputArgs, false, inputDuration);

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

// a program recording starts with the previous program: up to 8 MiB that Mirakurun held while it waited for the
// program, then the broadcaster's lag from the EIT switch to the audio change (review D12-1: 19.2 s at History 06:00,
// 5.3 s at NHK BS 05:30)
test('splits a dual-mono recording that starts with 19.2 s of the previous program\'s stereo', async t => {
    assert.deepStrictEqual(await recordingPlan(t, [[19.2, false], [100, true]]), SPLIT);
});

test('does not split a stereo recording that starts with 19.2 s of the previous program\'s dual mono', async t => {
    assert.deepStrictEqual(await recordingPlan(t, [[19.2, true], [100, false]]), NO_SPLIT);
});

test('judges dual mono on the 5 s from 60 s into a recording', async t => {
    // a lead-in of 59 s is ignored
    assert.deepStrictEqual(await recordingPlan(t, [[59, true], [100, false]]), NO_SPLIT);
    // dual mono from 64 s on is inside the window, from 66 s on is not
    assert.deepStrictEqual(await recordingPlan(t, [[64, false], [100, true]]), SPLIT);
    assert.deepStrictEqual(await recordingPlan(t, [[66, false], [100, true]]), NO_SPLIT);
});

test('judges a recording shorter than 65 s on its last 5 s', async t => {
    assert.deepStrictEqual(await recordingPlan(t, [[19.2, false], [10.8, true]]), SPLIT);
    assert.deepStrictEqual(await recordingPlan(t, [[19.2, true], [10.8, false]]), NO_SPLIT);
    // a recording of 5 s or less is judged from its start
    assert.deepStrictEqual(await recordingPlan(t, [[3, true]]), SPLIT);
});

test('judges an input of unknown duration, as a stream\'s probe window, on its first 5 s as a whole', async t => {
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: [[2, true]] }, [], true), SPLIT);
    // dual mono anywhere in the first 5 s splits, after them it does not
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: [[1, true], [3, false]] }, [], true), SPLIT);
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: [[4.5, false], [60, true]] }, [], true), SPLIT);
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: [[5.5, false], [60, true]] }, [], true), {
        ...NO_SPLIT,
        audioMapArgs: ['-map', '0:a:0'],
    });
    // a recording of unknown duration is judged 60 s in, as a long one (review D23-1)
    assert.deepStrictEqual(await plan(t, { audioStreams: 1, dualMono: [[5.5, false], [60, true]] }, [], false, NaN), SPLIT);
});

test('maps every audio stream when there are several, without checking for dual mono', async t => {
    // a failing dual-mono check would reject: it must not run
    assert.deepStrictEqual(await plan(t, { audioStreams: 2, dualMono: 'fail' }), {
        filterComplex: null,
        audioMapArgs: ['-map', '0:a'],
        trackCount: 2,
    });
});

// a program recording that follows a program with two audio streams starts with both, and the 2nd one leaves the PMT
// with the previous program (review D13-1: テレ東 09:15, 2nd stream's packets until 5.16 s of 275 s)
test('maps only the audio stream that the program has when a 2nd one is only in the lead-in', async t => {
    assert.deepStrictEqual(
        await plan(t, { audioStreams: 2, audioPackets: [[0, 275], [0, 5.16]], dualMono: false }, [], false, 275),
        { filterComplex: null, audioMapArgs: ['-map', '0:a:0'], trackCount: 1 },
    );
});

test('splits a dual-mono program recorded after a program with two audio streams', async t => {
    assert.deepStrictEqual(
        await plan(t, { audioStreams: 2, audioPackets: [[0, 300], [0, 5]], dualMono: [[5, false], [295, true]] }, [], false, 300),
        SPLIT,
    );
});

// BS日テレ 142's recording of a simulcast program after its own (review D22-2): the lead-in's own audio (stream 1)
// ended 6 s in, yet ffprobe printed 2 of its packets in the 60-65 s window; its programs listed only the program's (11)
test('maps only the audio stream that ffprobe\'s programs list when a lead-in stream shows packets in the window', async t => {
    const tools = { audioStreams: 2, audioPackets: [[0, 1e9], [6, 1e9]], pmtStreams: [11, 30] };
    assert.deepStrictEqual(await plan(t, { ...tools, dualMono: false }, [], false, 300), {
        filterComplex: null,
        audioMapArgs: ['-map', '0:a:1'],
        trackCount: 1,
    });
});

test('maps and judges the program\'s audio stream when it is not the first one', async t => {
    const tools = { audioStreams: 2, audioPackets: [[0, 5], [4, 300]] };
    assert.deepStrictEqual(await plan(t, { ...tools, dualMono: false }, [], false, 300), {
        filterComplex: null,
        audioMapArgs: ['-map', '0:a:1'],
        trackCount: 1,
    });
    assert.deepStrictEqual(await plan(t, { ...tools, dualMono: true }, [], false, 300), {
        ...SPLIT,
        filterComplex: SPLIT.filterComplex.replace('[0:a:0]', '[0:a:1]'),
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-track-plan-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const callLog = path.join(dir, 'calls');
    const { ffmpeg, ffprobe } = writeFakeTools(dir, { ...tools, callLog });
    await audioTrackPlan(ffprobe, ffmpeg, 'in.m2ts', [], false, 300);
    assert.deepStrictEqual(fs.readFileSync(callLog, 'utf8').trimEnd().split('\n').sort(), [
        'ffmpeg -v error -dual_mono_mode main -ss 60 -i in.m2ts -map 0:a:1 -t 5 -f s16le -',
        'ffmpeg -v error -dual_mono_mode sub -ss 60 -i in.m2ts -map 0:a:1 -t 5 -f s16le -',
        'ffprobe -v error -read_intervals +60%+5 -select_streams a -show_entries packet=stream_index:program_stream=index -of json in.m2ts',
        'ffprobe -v error -select_streams a -show_entries stream=index -of json in.m2ts',
    ]);
});

test('maps every audio stream that the program has', async t => {
    // a failing dual-mono check would reject: it must not run
    assert.deepStrictEqual(await plan(t, { audioStreams: 2, dualMono: 'fail' }, [], false, 300), {
        filterComplex: null,
        audioMapArgs: ['-map', '0:a'],
        trackCount: 2,
    });
    assert.deepStrictEqual(
        await plan(t, { audioStreams: 3, audioPackets: [[0, 300], [0, 5], [0, 300]], dualMono: 'fail' }, [], false, 300),
        { filterComplex: null, audioMapArgs: ['-map', '0:a:0', '-map', '0:a:2'], trackCount: 2 },
    );
});

test('looks for the program\'s audio streams on the 5 s from 60 s in, or the last 5 s of a shorter recording', async t => {
    const leadIn = (seconds, duration) =>
        plan(t, { audioStreams: 2, audioPackets: [[0, duration], [0, seconds]], dualMono: false }, [], false, duration);
    const ONE = { filterComplex: null, audioMapArgs: ['-map', '0:a:0'], trackCount: 1 };
    const BOTH = { filterComplex: null, audioMapArgs: ['-map', '0:a'], trackCount: 2 };
    // a 2nd stream that ends inside the window is the program's
    assert.deepStrictEqual(await leadIn(59, 300), ONE);
    assert.deepStrictEqual(await leadIn(61, 300), BOTH);
    assert.deepStrictEqual(await leadIn(19, 30), ONE);
    assert.deepStrictEqual(await leadIn(26, 30), BOTH);
    // a recording of 5 s or less keeps every stream; one of unknown length is looked at 60 s in (review D23-1)
    assert.deepStrictEqual(await leadIn(2, 5), BOTH);
    assert.deepStrictEqual(
        await plan(t, { audioStreams: 2, audioPackets: [[0, 300], [0, 2]], dualMono: false }, [], false, NaN),
        ONE,
    );
});

test('maps every audio stream when none has packets where the program is looked for', async t => {
    assert.deepStrictEqual(
        await plan(t, { audioStreams: 2, audioPackets: [[0, 50], [0, 50]], dualMono: 'fail' }, [], false, 300),
        { filterComplex: null, audioMapArgs: ['-map', '0:a'], trackCount: 2 },
    );
});

test('maps only the first of several audio streams for a stream, without checking for dual mono', async t => {
    // a 2nd audio stream that leaves the PMT mid-program stalls every output of ffmpeg 9
    assert.deepStrictEqual(await plan(t, { audioStreams: 2, dualMono: 'fail' }, [], true), {
        filterComplex: null,
        audioMapArgs: ['-map', '0:a:0'],
        trackCount: 1,
    });
    // also with a known length and a first stream that is only in the lead-in
    assert.deepStrictEqual(await plan(t, { audioStreams: 2, audioPackets: [[0, 5], [0, 300]], dualMono: 'fail' }, [], true, 300), {
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
        'ffmpeg -v error -dual_mono_mode main -analyzeduration 7M -i in.m2ts -map 0:a:0 -t 5 -f s16le -',
        'ffmpeg -v error -dual_mono_mode sub -analyzeduration 7M -i in.m2ts -map 0:a:0 -t 5 -f s16le -',
        'ffprobe -v error -analyzeduration 7M -select_streams a -show_entries stream=index -of json in.m2ts',
    ]);
});

test('adds no input options when none are given', async t => {
    assert.deepStrictEqual(await callsOf(t), [
        'ffmpeg -v error -dual_mono_mode main -i in.m2ts -map 0:a:0 -t 5 -f s16le -',
        'ffmpeg -v error -dual_mono_mode sub -i in.m2ts -map 0:a:0 -t 5 -f s16le -',
        'ffprobe -v error -select_streams a -show_entries stream=index -of json in.m2ts',
    ]);
});

test('seeks the dual-mono decodes, after the input options, to 60 s or to 5 s before the end of a shorter input', async t => {
    assert.deepStrictEqual(await callsOf(t, ['-analyzeduration', '7M'], 1800.5), [
        'ffmpeg -v error -dual_mono_mode main -analyzeduration 7M -ss 60 -i in.m2ts -map 0:a:0 -t 5 -f s16le -',
        'ffmpeg -v error -dual_mono_mode sub -analyzeduration 7M -ss 60 -i in.m2ts -map 0:a:0 -t 5 -f s16le -',
        'ffprobe -v error -analyzeduration 7M -select_streams a -show_entries stream=index -of json in.m2ts',
    ]);
    assert.deepStrictEqual((await callsOf(t, [], 30.5)).slice(0, 2), [
        'ffmpeg -v error -dual_mono_mode main -ss 25.5 -i in.m2ts -map 0:a:0 -t 5 -f s16le -',
        'ffmpeg -v error -dual_mono_mode sub -ss 25.5 -i in.m2ts -map 0:a:0 -t 5 -f s16le -',
    ]);
    // no seek for an input of 5 s or less
    assert.deepStrictEqual((await callsOf(t, [], 4)).slice(0, 2), [
        'ffmpeg -v error -dual_mono_mode main -i in.m2ts -map 0:a:0 -t 5 -f s16le -',
        'ffmpeg -v error -dual_mono_mode sub -i in.m2ts -map 0:a:0 -t 5 -f s16le -',
    ]);
});

test('puts the input options before the input in the probe for the program\'s audio streams', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-track-plan-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const callLog = path.join(dir, 'calls');
    const { ffmpeg, ffprobe } = writeFakeTools(dir, { audioStreams: 2, callLog });
    await audioTrackPlan(ffprobe, ffmpeg, 'in.m2ts', ['-analyzeduration', '7M'], false, 30.5);

    assert.deepStrictEqual(fs.readFileSync(callLog, 'utf8').trimEnd().split('\n'), [
        'ffprobe -v error -analyzeduration 7M -select_streams a -show_entries stream=index -of json in.m2ts',
        'ffprobe -v error -analyzeduration 7M -read_intervals +25.5%+5 -select_streams a -show_entries packet=stream_index:program_stream=index -of json in.m2ts',
    ]);
});

test('rejects when ffprobe fails', async t => {
    await assert.rejects(plan(t, { audioStreams: 1, inputDuration: 'fail' }));
});
