const { describe, it, before, after } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { runSignalCommand } = require("../lib/Mirakurun/SignalChecker");

const tmpDir = path.join(__dirname, "tmp");

/** Write an executable stand-in for a tuner program. */
function writeFakeTuner(name, body) {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
}

describe("[signal-command.spec] running a signal check command", () => {
    let recisdbLike, recpt1Like, dvbv5Like, silent, failing;

    before(() => {
        // recisdb: loops forever writing "\r<level>dB" to stdout, never exits
        recisdbLike = writeFakeTuner("fake-recisdb.sh",
            'while true; do printf "\\r12.34dB"; sleep 0.05; done');
        // recpt1 checksignal: loops forever writing "\rC/N = <level>dB " to stderr
        recpt1Like = writeFakeTuner("fake-recpt1.sh",
            'while true; do printf "\\rC/N = 30.500000dB " 1>&2; sleep 0.05; done');
        // dvbv5-zap -m: one newline-terminated line to stderr carrying both units
        dvbv5Like = writeFakeTuner("fake-dvbv5-zap.sh",
            'while true; do printf "Lock   (0x1f) Quality= Good Signal= -21.05dBm C/N= 22.50dB UCB= 0 postBER= 0\\n" 1>&2; sleep 0.05; done');
        // runs but never reports a level
        silent = writeFakeTuner("fake-silent.sh",
            'while true; do sleep 0.05; done');
        // fails immediately, as a tuner program does when the device is missing
        failing = writeFakeTuner("fake-failing.sh",
            'echo "Cannot open the device" 1>&2; exit 1');
    });

    after(() => {
        for (const f of ["fake-recisdb.sh", "fake-recpt1.sh", "fake-dvbv5-zap.sh", "fake-silent.sh", "fake-failing.sh"]) {
            try {
                fs.unlinkSync(path.join(tmpDir, f));
            } catch (_) { /* already gone */ }
        }
    });

    it("collects levels from stdout and stops at the duration", async () => {
        const samples = [];
        const startedAt = Date.now();

        await runSignalCommand(recisdbLike, {
            duration: 300,
            onSample: s => samples.push(s)
        });

        assert.ok(samples.length > 0, "expected at least one sample");
        assert.strictEqual(samples[0].level, 12.34);
        assert.ok(typeof samples[0].time === "number");
        // it loops forever, so returning at all means we terminated it
        assert.ok(Date.now() - startedAt < 3000, "should stop at the duration");
    });

    it("collects levels from stderr (recpt1 writes there, not stdout)", async () => {
        const samples = [];

        await runSignalCommand(recpt1Like, {
            duration: 300,
            onSample: s => samples.push(s)
        });

        assert.ok(samples.length > 0, "expected at least one sample");
        assert.strictEqual(samples[0].level, 30.5);
    });

    it("stops early when aborted", async () => {
        const samples = [];
        const abort = new AbortController();
        const startedAt = Date.now();

        setTimeout(() => abort.abort(), 150);

        await runSignalCommand(recisdbLike, {
            duration: 30000,
            signal: abort.signal,
            onSample: s => samples.push(s)
        });

        assert.ok(Date.now() - startedAt < 5000, "abort should end the run promptly");
    });

    it("resolves without samples if the command is silent but alive", async () => {
        const samples = [];
        await runSignalCommand(silent, { duration: 200, onSample: s => samples.push(s) });
        assert.strictEqual(samples.length, 0);
    });

    it("rejects when the command exits without reporting a level", async () => {
        await assert.rejects(
            () => runSignalCommand(failing, { duration: 5000, onSample: () => {} }),
            err => {
                assert.match(err.message, /without reporting a level/);
                // the command's own complaint is surfaced for diagnosis
                assert.match(err.message, /Cannot open the device/);
                return true;
            }
        );
    });

    it("rejects an empty command", async () => {
        await assert.rejects(
            () => runSignalCommand("   ", { duration: 100, onSample: () => {} }),
            /command is empty or invalid/
        );
    });

    it("does not leave the process running after it returns", async () => {
        const samples = [];
        await runSignalCommand(recisdbLike, { duration: 200, onSample: s => samples.push(s) });
        const before = samples.length;
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.strictEqual(samples.length, before, "no samples should arrive after the run ends");
    });

    it("reports SIG (dBm) and C/N (dB) from a dvbv5-zap style command", async () => {
        const samples = [];

        await runSignalCommand(dvbv5Like, {
            duration: 300,
            onSample: s => samples.push(s)
        });

        assert.ok(samples.length > 0, "expected at least one sample");
        assert.strictEqual(samples[0].strength, -21.05);
        assert.strictEqual(samples[0].level, 22.5);
        // one reading per line, not one per value
        assert.ok(samples.every(s => s.level === 22.5 && s.strength === -21.05));
    });

    it("leaves the unreported unit null rather than guessing", async () => {
        const samples = [];
        await runSignalCommand(recisdbLike, { duration: 200, onSample: s => samples.push(s) });
        assert.ok(samples.length > 0);
        assert.strictEqual(samples[0].level, 12.34);
        assert.strictEqual(samples[0].strength, null);
    });
});
