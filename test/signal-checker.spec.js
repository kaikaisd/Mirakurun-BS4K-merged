const { describe, it } = require("node:test");
const assert = require("assert");

const { SignalLevelParser } = require("../lib/Mirakurun/SignalChecker");

describe("[signal-checker.spec] signal level parsing", () => {
    it("parses recisdb output (stdout, `\\r12.34dB`, no newline)", () => {
        const parser = new SignalLevelParser();
        // recisdb-rs: print!("\r{:.2}dB", tuned.signal_quality())
        assert.deepStrictEqual(parser.push("\r12.34dB"), [{ level: 12.34, strength: null }]);
        assert.deepStrictEqual(parser.push("\r13.05dB"), [{ level: 13.05, strength: null }]);
    });

    it("parses recpt1 output (stderr, `\\rC/N = 30.500000dB `)", () => {
        const parser = new SignalLevelParser();
        // recpt1: fprintf(stderr, "\rC/N = %fdB ", CNR)
        assert.deepStrictEqual(parser.push("\rC/N = 30.500000dB "), [{ level: 30.5, strength: null }]);
        assert.deepStrictEqual(parser.push("\rC/N = 28.125000dB "), [{ level: 28.125, strength: null }]);
    });

    it("holds a reading split across chunks until it is complete", () => {
        const parser = new SignalLevelParser();
        assert.deepStrictEqual(parser.push("\r12.3"), []);
        assert.deepStrictEqual(parser.push("4dB"), [{ level: 12.34, strength: null }]);
    });

    it("does not re-emit a reading already reported", () => {
        const parser = new SignalLevelParser();
        assert.deepStrictEqual(parser.push("\r9.00dB"), [{ level: 9, strength: null }]);
        assert.deepStrictEqual(parser.push(""), []);
        assert.deepStrictEqual(parser.push("\r9.00dB"), [{ level: 9, strength: null }]);
    });

    it("returns every reading when several arrive in one chunk", () => {
        const parser = new SignalLevelParser();
        assert.deepStrictEqual(
            parser.push("\r10.00dB\r11.00dB\r12.00dB"),
            [
                { level: 10, strength: null },
                { level: 11, strength: null },
                { level: 12, strength: null }
            ]
        );
    });

    it("parses negative and integer levels", () => {
        const parser = new SignalLevelParser();
        assert.deepStrictEqual(parser.push("\r-0.01dB"), [{ level: -0.01, strength: null }]);
        assert.deepStrictEqual(parser.push("\r0dB"), [{ level: 0, strength: null }]);
    });

    it("ignores output that carries no level", () => {
        const parser = new SignalLevelParser();
        assert.deepStrictEqual(parser.push("No signal. Still trying: /dev/pt1video0\n"), []);
        assert.deepStrictEqual(parser.push("Tuner Select Error\n"), []);
    });

    it("does not grow its buffer without bound on output that never matches", () => {
        const parser = new SignalLevelParser();
        for (let i = 0; i < 200; i++) {
            assert.deepStrictEqual(parser.push("no signal here at all ".repeat(10)), []);
        }
        // still parses correctly afterwards
        assert.deepStrictEqual(parser.push("\r7.25dB"), [{ level: 7.25, strength: null }]);
    });

    it("is case-insensitive about the unit", () => {
        const parser = new SignalLevelParser();
        assert.deepStrictEqual(parser.push("\r15.00DB"), [{ level: 15, strength: null }]);
    });

    it("parses dvbv5-zap output, pairing SIG (dBm) with C/N (dB) in one reading", () => {
        const parser = new SignalLevelParser();
        // exact format from libdvbv5 dvb_fe_snprintf_stat + dvbv5-zap print_frontend_stats
        const line = "Lock   (0x1f) Quality= Good Signal= -21.05dBm C/N= 22.50dB UCB= 0 postBER= 0\n";
        assert.deepStrictEqual(parser.push(line), [{ level: 22.5, strength: -21.05 }]);
    });

    it("does not report a dBm strength as if it were a dB C/N", () => {
        const parser = new SignalLevelParser();
        // regression: /(\d+)dB/ matches the "-21.05dB" inside "-21.05dBm",
        // which would show an overdriven-but-fine tuner as a poor C/N
        assert.deepStrictEqual(
            parser.push("Signal= -21.05dBm\n"),
            [{ level: null, strength: -21.05 }]
        );
    });

    it("keeps successive dvbv5-zap lines as separate readings", () => {
        const parser = new SignalLevelParser();
        const out =
            "Lock   (0x1f) Signal= -21.05dBm C/N= 22.50dB UCB= 0\n" +
            "Lock   (0x1f) Signal= -20.15dBm C/N= 23.10dB UCB= 0\n";
        assert.deepStrictEqual(parser.push(out), [
            { level: 22.5, strength: -21.05 },
            { level: 23.1, strength: -20.15 }
        ]);
    });

    it("handles a dvbv5-zap line split across chunks", () => {
        const parser = new SignalLevelParser();
        assert.deepStrictEqual(parser.push("Lock (0x1f) Signal= -21.0"), []);
        assert.deepStrictEqual(parser.push("5dBm C/N= 22.50dB UCB= 0\n"), [{ level: 22.5, strength: -21.05 }]);
    });

    it("ignores percentage-scale stats, which are not dB", () => {
        const parser = new SignalLevelParser();
        // FE_SCALE_RELATIVE tuners print "%" instead; nothing is reported rather than a wrong number
        assert.deepStrictEqual(parser.push("Lock (0x1f) Signal= 65.00% C/N= 70.00%\n"), []);
    });
});
