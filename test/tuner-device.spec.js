const { describe, it, beforeEach } = require("node:test");
const assert = require("assert");
const EventEmitter = require("events");

const shared = require("../lib/Mirakurun/_").default;
const MirakurunEvent = require("../lib/Mirakurun/Event").default;
const ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
const remoteExitCodes = require("../lib/remoteExitCodes");
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = {
    id: statusPath,
    filename: statusPath,
    loaded: true,
    exports: {
        __esModule: true,
        default: {
            errorCount: {
                tunerDeviceRespawn: 0
            }
        }
    }
};
const TunerDeviceModule = require("../lib/Mirakurun/TunerDevice");
const TunerDevice = TunerDeviceModule.default;
const TunerStartupError = TunerDeviceModule.TunerStartupError;
const Tuner = require("../lib/Mirakurun/Tuner").default;
const log = require("../lib/Mirakurun/log");

function createChannel() {
    return new ChannelItem({
        name: "Test",
        type: "GR-ALT",
        channel: "27"
    });
}

function createDevice() {
    return new TunerDevice(0, {
        name: "J-GR-1",
        types: ["GR-ALT"],
        remoteMirakurunHost: "127.0.0.1"
    });
}

function createStream() {
    const stream = new EventEmitter();
    stream.closed = false;
    stream.end = () => {
        if (stream.closed === false) {
            stream.closed = true;
            stream.emit("close");
        }
    };
    return stream;
}

function installFakeSpawn(device) {
    device._spawn = function (channel) {
        const tunerProcess = new EventEmitter();
        tunerProcess.pid = 123;
        tunerProcess.stderr = new EventEmitter();
        tunerProcess.kill = () => undefined;

        this._process = tunerProcess;
        this._stream = new EventEmitter();
        this._channel = channel;
        this._command = "fake remote";
    };
}

describe("[tuner-device.spec] remote stream startup", () => {
    beforeEach(() => {
        shared.event = new MirakurunEvent();
    });

    it("waits for the first remote stream data", async () => {
        const device = createDevice();
        const channel = createChannel();
        const output = createStream();
        installFakeSpawn(device);

        const starting = device.startStream({
            id: "test",
            priority: 0,
            streamSetting: { channel }
        }, output, channel);

        setImmediate(() => device._stream.emit("data", Buffer.from([0x47])));

        await starting;
        assert.strictEqual(device.users.length, 1);
    });

    it("rejects when the remote process closes before producing data", async () => {
        const device = createDevice();
        const channel = createChannel();
        const output = createStream();
        installFakeSpawn(device);

        const starting = device.startStream({
            id: "test",
            priority: 0,
            streamSetting: { channel }
        }, output, channel);

        setImmediate(() => {
            device._exited = true;
            device._process.emit("close", remoteExitCodes.REMOTE_EXIT_SOURCE_UNAVAILABLE, null);
        });

        await assert.rejects(starting, err => {
            assert.ok(err instanceof TunerStartupError);
            assert.strictEqual(err.failureScope, "source");
            return true;
        });
        assert.strictEqual(device.users.length, 0);
    });

    it("ends remote users instead of respawning the same failed tuner", () => {
        const device = createDevice();
        const channel = createChannel();
        const output = createStream();
        const tunerProcess = new EventEmitter();
        tunerProcess.stderr = new EventEmitter();

        device._process = tunerProcess;
        device._stream = new EventEmitter();
        device._channel = channel;
        device._users.add({
            id: "test",
            priority: 0,
            streamSetting: { channel },
            _stream: output
        });

        let failedChannel = null;
        device.once("streamFailure", value => failedChannel = value);
        device._release();

        assert.strictEqual(failedChannel, channel);
        assert.strictEqual(output.closed, true);
        assert.strictEqual(device.users.length, 0);
        assert.strictEqual(device.pid, null);
    });
});

describe("[tuner-device.spec] remote source circuit breaker", () => {
    it("groups tuner devices from the same remote source", () => {
        const tuner = Object.create(Tuner.prototype);
        tuner._sourceFailureState = new Map();

        const first = {
            index: 10,
            isRemote: true,
            config: {
                remoteMirakurunHost: "10.77.0.1",
                remoteMirakurunPort: 40772
            }
        };
        const second = {
            index: 11,
            isRemote: true,
            config: {
                remoteMirakurunHost: "10.77.0.1",
                remoteMirakurunPort: 40772
            }
        };

        tuner._markSourceFailure(first);

        assert.strictEqual(tuner._isSourceFailureCoolingDown(second), true);
    });

    it("allows only one half-open probe after the source cooldown", () => {
        const tuner = Object.create(Tuner.prototype);
        tuner._sourceFailureState = new Map();
        const channel = createChannel();
        const device = {
            index: 10,
            isRemote: true,
            config: {
                remoteMirakurunHost: "10.77.0.1",
                remoteMirakurunPort: 40772
            }
        };

        tuner._markSourceFailure(device);
        const state = tuner._sourceFailureState.get("10.77.0.1:40772");
        state.retryAt = Date.now() - 1;

        assert.strictEqual(tuner._beginSourceProbe(device, channel), true);
        assert.strictEqual(tuner._beginSourceProbe(device, channel), false);
        assert.strictEqual(tuner._isSourceFailureCoolingDown(device), true);
    });

    it("recovers the remote source after a stable probe", () => {
        const tuner = Object.create(Tuner.prototype);
        tuner._sourceFailureState = new Map();
        const channel = createChannel();
        const device = {
            index: 10,
            isRemote: true,
            isUsing: true,
            channel,
            lastDataAt: Date.now(),
            config: {
                remoteMirakurunHost: "10.77.0.1",
                remoteMirakurunPort: 40772
            }
        };
        tuner._sourceFailureState.set("10.77.0.1:40772", {
            retryAt: 0,
            probing: true,
            generation: 3,
            probeDeviceIndex: 10,
            probeChannelKey: "GR-ALT:27"
        });

        tuner._completeSourceRecoveryProbe(device, channel, "10.77.0.1:40772", 3);

        assert.strictEqual(tuner._sourceFailureState.has("10.77.0.1:40772"), false);
    });

    it("reopens the circuit when the probe stops producing data", async () => {
        const tuner = Object.create(Tuner.prototype);
        tuner._sourceFailureState = new Map();
        const channel = createChannel();
        let killed = false;
        const device = {
            index: 10,
            isRemote: true,
            isUsing: true,
            channel,
            lastDataAt: 0,
            config: {
                remoteMirakurunHost: "10.77.0.1",
                remoteMirakurunPort: 40772
            },
            kill: async () => {
                killed = true;
            }
        };
        tuner._sourceFailureState.set("10.77.0.1:40772", {
            retryAt: 0,
            probing: true,
            generation: 3,
            probeDeviceIndex: 10,
            probeChannelKey: "GR-ALT:27"
        });

        tuner._completeSourceRecoveryProbe(device, channel, "10.77.0.1:40772", 3);
        await new Promise(resolve => setImmediate(resolve));

        const state = tuner._sourceFailureState.get("10.77.0.1:40772");
        assert.strictEqual(state.probing, false);
        assert.ok(state.retryAt > Date.now());
        assert.strictEqual(killed, true);
    });
});

describe("[tuner-device.spec] local-only channel selection", () => {
    it("reports local availability after applying allowedTuners", () => {
        const tuner = Object.create(Tuner.prototype);
        const channel = createChannel();
        tuner._devices = [
            {
                isRemote: false,
                config: {
                    name: "LOCAL-GR-1",
                    types: ["GR-ALT"]
                }
            },
            {
                isRemote: true,
                config: {
                    name: "J-GR-1",
                    types: ["GR-ALT"]
                }
            }
        ];

        assert.strictEqual(tuner.hasLocalTunerForChannel(channel), true);

        channel.setAllowedTuners(["J-GR-1"]);

        assert.strictEqual(tuner.hasLocalTunerForChannel(channel), false);
    });
});

describe("[tuner-device.spec] TunerDevice#tlvDecoder getter", () => {
    beforeEach(() => {
        shared.event = new MirakurunEvent();
    });

    it("returns null when tlvDecoder is missing/undefined in config", () => {
        const device = new TunerDevice(0, {
            name: "J-BS4K-1",
            types: ["BS4K"],
            command: "echo"
        });

        assert.strictEqual(device.tlvDecoder, null);
    });

    it("returns the configured string when tlvDecoder is set", () => {
        const device = new TunerDevice(0, {
            name: "J-BS4K-1",
            types: ["BS4K"],
            command: "echo",
            tlvDecoder: "decode-tlv --stdin"
        });

        assert.strictEqual(device.tlvDecoder, "decode-tlv --stdin");
    });
});

describe("[tuner-device.spec] Tuner#_load tlvDecoder validation", () => {
    beforeEach(() => {
        shared.event = new MirakurunEvent();
    });

    it("accepts tlvDecoder: null and keeps the device registered", () => {
        shared.config.tuners = [
            {
                name: "J-BS4K-1",
                types: ["BS4K"],
                command: "echo",
                tlvDecoder: null
            }
        ];

        const tuner = Object.create(Tuner.prototype);
        tuner._devices = [];
        tuner._load();

        assert.strictEqual(tuner._devices.length, 1);
        assert.strictEqual(tuner._devices[0].tlvDecoder, null);
    });

    it("rejects a non-string, non-null tlvDecoder and skips the tuner (error logged)", () => {
        shared.config.tuners = [
            {
                name: "J-BS4K-1",
                types: ["BS4K"],
                command: "echo",
                tlvDecoder: 123
            }
        ];

        const loggedLines = [];
        const onLog = line => loggedLines.push(line);
        log.event.on("data", onLog);

        const tuner = Object.create(Tuner.prototype);
        tuner._devices = [];
        try {
            tuner._load();
        } finally {
            log.event.removeListener("data", onLog);
        }

        assert.strictEqual(tuner._devices.length, 0);
        assert.ok(loggedLines.some(line => /tlvDecoder/.test(line)));
    });
});
