const { describe, it, beforeEach } = require("node:test");
const assert = require("assert");

// `status` installs 1s/9s/10s timers at load, so stub it before the module
// under test pulls it in - otherwise the test process never drains its loop.
const statusPath = require.resolve("../lib/Mirakurun/status");
const status = {
    epg: {},
    rpcCount: 0,
    streamCount: {
        tsFilter: 0,
        decoder: 0,
        tlvFilter: 0
    },
    epgByChannel: {},
    errorCount: {
        uncaughtException: 0,
        unhandledRejection: 0,
        bufferOverflow: 0,
        tunerDeviceRespawn: 0,
        decoderRespawn: 0
    },
    timerAccuracy: {
        last: 0,
        m1: [0],
        m5: [0],
        m15: [0]
    }
};
require.cache[statusPath] = {
    id: statusPath,
    filename: statusPath,
    loaded: true,
    exports: {
        __esModule: true,
        default: status
    }
};

const shared = require("../lib/Mirakurun/_").default;
const { get, getStatus } = require("../lib/Mirakurun/api/status");

function responseBody() {
    return new Promise((resolve, reject) => {
        const res = {
            setHeader: () => {},
            status: () => {},
            end: body => resolve(body)
        };
        try {
            get({}, res);
        } catch (err) {
            reject(err);
        }
    });
}

describe("[api-status.spec] GET /api/status streamCount", () => {

    beforeEach(() => {
        status.streamCount.tsFilter = 0;
        status.streamCount.decoder = 0;
        status.streamCount.tlvFilter = 0;
        shared.tuner = { devices: [] };
        shared.program = { itemMap: new Map() };
    });

    it("reports tlvFilter as a number in the response body", async () => {
        const body = JSON.parse(await responseBody());

        assert.strictEqual(typeof body.streamCount.tlvFilter, "number");
    });

    it("reports the live tlvFilter counter while a TLV stream is open", async () => {
        status.streamCount.tlvFilter = 2;

        const body = JSON.parse(await responseBody());

        assert.strictEqual(body.streamCount.tlvFilter, 2);
    });

    it("reports tlvFilter alongside tunerDevice, tsFilter and decoder", () => {
        shared.tuner.devices = [{ isUsing: true }, { isUsing: false }];
        status.streamCount.tsFilter = 3;
        status.streamCount.decoder = 1;
        status.streamCount.tlvFilter = 4;

        const { streamCount } = getStatus();

        assert.deepStrictEqual(streamCount, {
            tunerDevice: 1,
            tsFilter: 3,
            decoder: 1,
            tlvFilter: 4
        });
    });
});
