const { describe, it, before, after, beforeEach, afterEach, mock } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const child_process = require("child_process");

// Fork behaviour on top of upstream's DVB Direct (see tunerdevice-dvb.spec.js for upstream's own
// cases). DVB Direct tunes ISDB-T / ISDB-S only, so a tuner that also carries BS4K has to share
// the adapter between DVB Direct and `commandBS4K`, and fork stream types without flush() have
// to keep working with the batched output.

// status.ts のタイマーでテストのプロセスが終了しなくなるため差し替える
const statusPath = path.join(__dirname, "../lib/Mirakurun/status.js");
require.cache[statusPath] = {
    id: statusPath,
    filename: statusPath,
    loaded: true,
    exports: { __esModule: true, default: { epg: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { tunerDeviceRespawn: 0 } } }
};

const log = require("../lib/Mirakurun/log");
const _ = require("../lib/Mirakurun/_").default;
const SignalChecker = require("../lib/Mirakurun/SignalChecker");
let TunerDevice;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-tunerdevice-bs4k-dvb-"));
const confPath = path.join(dir, "channels.conf");
fs.writeFileSync(confPath, [
    "[27]", "\tDELIVERY_SYSTEM = ISDBT", "\tFREQUENCY = 557142857", "\tBANDWIDTH_HZ = 6000000"
].join("\n"));

const flush = () => new Promise(resolve => setImmediate(resolve));

// same contract as FakeDvb in tunerdevice-dvb.spec.js
class FakeDvb extends EventEmitter {
    constructor() {
        super();
        this.path = "/dev/dvb/adapter9";
        this.isOpen = false;
        this.calls = [];
        this.pendings = [];
        this.queue = Promise.resolve();
    }
    serial(fn) {
        const result = this.queue.then(fn);
        this.queue = result.catch(() => {});
        return result;
    }
    start(params) {
        return this.serial(() => {
            this.calls.push(["start", params.properties[0][1]]);
            this.isOpen = true;
            return new Promise((resolve, reject) => this.pendings.push({ resolve, reject }));
        });
    }
    async resolveStart() {
        const startedAt = performance.now();
        while (this.pendings.length === 0) {
            if (performance.now() - startedAt > 5000) {
                throw new Error("start() has not been called");
            }
            await flush();
        }
        this.pendings.shift().resolve();
        await flush();
    }
    stopStream() {
        return this.serial(async () => {
            this.calls.push(["stopStream"]);
        });
    }
    close() {
        return this.serial(async () => {
            this.calls.push(["close"]);
            this.isOpen = false;
        });
    }
}

// TSFilter-like: supports batched output
function flushableStream() {
    const stream = new EventEmitter();
    stream.closed = false;
    stream.ended = false;
    stream.writes = [];
    stream.flushes = 0;
    stream.write = (chunk, defer) => stream.writes.push([chunk.length, defer === true]);
    stream.flush = () => ++stream.flushes;
    stream.end = () => {
        stream.ended = true;
    };
    return stream;
}

// TLVFilter / TSHandoffBuffer-like: no flush()
function plainStream() {
    const stream = new EventEmitter();
    stream.closed = false;
    stream.ended = false;
    stream.writes = [];
    stream.write = (...args) => stream.writes.push(args.length);
    stream.end = () => {
        stream.ended = true;
    };
    return stream;
}

const gr = ch => ({ type: "GR", channel: ch });
const bs4k = ch => ({ type: "BS4K", channel: ch });
const user = (id, priority = 0) => ({ id, priority });

function createDevice() {
    const device = new TunerDevice(9, {
        name: "dvb-bs4k",
        types: ["GR", "BS4K"],
        command: "recpt1 <channel> - -",
        commandBS4K: "recisdb tune -c <channel> -",
        commandSignal: "recisdb checksignal -c <channel>"
    });
    const dvb = new FakeDvb();
    // _initDvb() と同じ設定 (koffi を使わない)
    device._dvb = dvb;
    device._dvbChannelsConfPath = confPath;
    dvb.on("data", device._streamOnData.bind(device));
    dvb.on("error", device._dvbOnError.bind(device));
    return [device, dvb];
}

function mockSpawn() {
    const processes = [];
    const spawn = mock.method(child_process, "spawn", (command, args) => {
        const p = new EventEmitter();
        p.pid = 1000 + processes.length;
        p.stdout = new EventEmitter();
        p.stderr = new EventEmitter();
        p.kill = () => p.emit("close", null, "SIGTERM");
        processes.push([command, ...args]);
        return p;
    });
    return { processes, restore: () => spawn.mock.restore() };
}

// GR on DVB Direct, then the last user leaves: the stream stops after 3s but the frontend stays
// open for another 1s so a re-tune can skip opening it
async function holdFrontendOpen(device, dvb) {
    const stream = flushableStream();
    const started = device.startStream(user("gr"), stream, gr("27"));
    await dvb.resolveStart();
    await started;
    stream.closed = true;
    stream.emit("close");
    mock.timers.tick(3000);
    await flush();
    assert.deepStrictEqual(dvb.calls, [["start", 557142857], ["stopStream"]]);
    assert.strictEqual(dvb.isOpen, true);
    assert.strictEqual(device.isFree, true);
}

describe("[tunerdevice-bs4k-dvb.spec] TunerDevice.ts: BS4K and fork streams on DVB Direct tuners", () => {
    let spawn;

    before(() => {
        for (const level of ["info", "debug", "warn", "error", "fatal"]) {
            log[level] = () => {};
        }
        _.event = { emit: () => true };
        TunerDevice = require("../lib/Mirakurun/TunerDevice").default;
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    beforeEach(() => {
        mock.timers.enable({ apis: ["setTimeout"] });
        spawn = mockSpawn();
    });
    afterEach(() => {
        spawn.restore();
        mock.timers.reset();
    });

    it("runs commandBS4K for a BS4K channel instead of tuning it directly", async () => {
        const [device, dvb] = createDevice();

        await device.startStream(user("a"), plainStream(), bs4k("BS_1"));

        assert.deepStrictEqual(dvb.calls, []);
        assert.deepStrictEqual(spawn.processes, [["recisdb", "tune", "-c", "BS_1", "-"]]);
        assert.strictEqual(device.pid, 1000);
    });

    it("closes the frontend held open by DVB Direct before running commandBS4K", async () => {
        const [device, dvb] = createDevice();
        await holdFrontendOpen(device, dvb);

        await device.startStream(user("b"), plainStream(), bs4k("BS_1"));

        assert.deepStrictEqual(dvb.calls, [["start", 557142857], ["stopStream"], ["close"]]);
        assert.deepStrictEqual(spawn.processes, [["recisdb", "tune", "-c", "BS_1", "-"]]);
        assert.strictEqual(device.channel.type, "BS4K");

        // the pending close timer of the GR stream was cancelled: nothing closes twice
        mock.timers.tick(5000);
        await flush();
        assert.strictEqual(dvb.calls.filter(([name]) => name === "close").length, 1);
    });

    it("closes the frontend before running commandBS4K when a higher priority BS4K user takes over", async () => {
        const [device, dvb] = createDevice();
        const low = flushableStream();
        const started = device.startStream(user("low", 0), low, gr("27"));
        await dvb.resolveStart();
        await started;

        await device.startStream(user("high", 1), plainStream(), bs4k("BS_1"));

        assert.strictEqual(low.ended, true);
        assert.deepStrictEqual(dvb.calls, [["start", 557142857], ["stopStream"], ["close"]]);
        assert.deepStrictEqual(spawn.processes, [["recisdb", "tune", "-c", "BS_1", "-"]]);
        assert.deepStrictEqual(device.users.map(u => u.id), ["high"]);
    });

    it("closes the frontend held open by DVB Direct before checking signal", async () => {
        const [device, dvb] = createDevice();
        await holdFrontendOpen(device, dvb);

        let openWhileChecking = null;
        const run = mock.method(SignalChecker, "runSignalCommand", async () => {
            openWhileChecking = dvb.isOpen;
        });
        try {
            await device.checkSignal(gr("27"), {});
        } finally {
            run.mock.restore();
        }

        assert.strictEqual(run.mock.callCount(), 1);
        assert.strictEqual(openWhileChecking, false);
        assert.deepStrictEqual(dvb.calls.slice(2), [["close"]]);

        mock.timers.tick(5000);
        await flush();
        assert.strictEqual(dvb.calls.filter(([name]) => name === "close").length, 1);
    });

    it("stops a DVB Direct stream 3 seconds after its last user is detached for handoff", async () => {
        const [device, dvb] = createDevice();
        const u = user("a");
        const started = device.startStream(u, flushableStream(), gr("27"));
        await dvb.resolveStart();
        await started;

        device.detachStream(u);
        mock.timers.tick(2999);
        await flush();
        assert.deepStrictEqual(dvb.calls, [["start", 557142857]]);

        mock.timers.tick(1);
        await flush();
        assert.deepStrictEqual(dvb.calls, [["start", 557142857], ["stopStream"]]);
        assert.strictEqual(device.isFree, true);
    });

    it("writes straight through to streams without flush() and batches the others", async () => {
        const [device, dvb] = createDevice();
        const ts = flushableStream();
        const tlv = plainStream();
        const started = device.startStream(user("ts"), ts, gr("27"));
        await dvb.resolveStart();
        await started;
        await device.startStream(user("tlv"), tlv, gr("27"));

        dvb.emit("data", Buffer.alloc(188));
        dvb.emit("data", Buffer.alloc(188));

        assert.deepStrictEqual(ts.writes, [[188, true], [188, true]]);
        assert.strictEqual(ts.flushes, 0);
        // a single-argument write each time: nothing is held back waiting for a flush
        assert.deepStrictEqual(tlv.writes, [1, 1]);

        mock.timers.tick(50);
        assert.strictEqual(ts.flushes, 1);
    });
});
