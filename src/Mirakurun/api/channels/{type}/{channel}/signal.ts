/*
   Copyright 2026 kanreisa

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
import { Operation } from "express-openapi";
import * as api from "../../../../api";
import * as apid from "../../../../../../api";
import _ from "../../../../_";
import { channelTypes } from "../../../../common";
import { SignalSample } from "../../../../SignalChecker";
import { TunerSignalError } from "../../../../Tuner";

const DEFAULT_DURATION = 5;
const MIN_DURATION = 1;
const MAX_DURATION = 60;

export const parameters = [
    {
        in: "path",
        name: "type",
        type: "string",
        enum: channelTypes,
        required: true
    },
    {
        in: "path",
        name: "channel",
        type: "string",
        required: true
    },
    {
        in: "query",
        name: "duration",
        type: "integer",
        minimum: MIN_DURATION,
        maximum: MAX_DURATION,
        default: DEFAULT_DURATION,
        required: false,
        description: "seconds to measure for."
    }
];

/** Map a tuner selection failure onto the status code that describes it. */
export function signalErrorStatus(err: unknown): { code: number; reason: string } {
    if (err instanceof TunerSignalError) {
        switch (err.code) {
            case "no-tuner":
                return { code: 404, reason: err.message };
            case "not-configured":
                // the feature is off until the user supplies a command
                return { code: 501, reason: err.message };
            case "busy":
                return { code: 503, reason: err.message };
        }
    }

    return { code: 500, reason: err instanceof Error ? err.message : String(err) };
}

/** min/max/average over the readings that actually carry a value. */
function stats(values: number[]): { min: number | null; max: number | null; average: number | null } {
    if (values.length === 0) {
        return { min: null, max: null, average: null };
    }

    let min = Infinity;
    let max = -Infinity;
    let total = 0;

    for (const value of values) {
        if (value < min) {
            min = value;
        }
        if (value > max) {
            max = value;
        }
        total += value;
    }

    return {
        min,
        max,
        average: Math.round((total / values.length) * 100) / 100
    };
}

/**
 * C/N (dB) and signal strength (dBm) are summarised separately: they are
 * different measurements, and most commands report only one of them.
 */
export function summarize(samples: SignalSample[]): Pick<
    apid.SignalCheckResult,
    "min" | "max" | "average" | "strengthMin" | "strengthMax" | "strengthAverage"
> {
    const cn = stats(samples.map(s => s.level).filter((v): v is number => v !== null));
    const strength = stats(samples.map(s => s.strength).filter((v): v is number => v !== null));

    return {
        min: cn.min,
        max: cn.max,
        average: cn.average,
        strengthMin: strength.min,
        strengthMax: strength.max,
        strengthAverage: strength.average
    };
}

export const get: Operation = async (req, res) => {
    const type = req.params.type as apid.ChannelType;
    const channel = _.channel.get(type, req.params.channel);

    if (channel === null) {
        api.responseError(res, 404);
        return;
    }

    const requested = parseInt(req.query.duration as string, 10);
    const duration = Math.min(
        Math.max(Number.isFinite(requested) ? requested : DEFAULT_DURATION, MIN_DURATION),
        MAX_DURATION
    );

    const abort = new AbortController();
    // stop driving the tuner as soon as the client is gone
    req.once("close", () => abort.abort());

    const samples: SignalSample[] = [];

    try {
        const result = await _.tuner.checkSignal(channel, {
            duration: duration * 1000,
            signal: abort.signal,
            onSample: sample => samples.push(sample)
        });

        if (res.writableEnded === true) {
            return;
        }

        const body: apid.SignalCheckResult = {
            type,
            channel: channel.channel,
            tunerIndex: result.tunerIndex,
            tunerName: result.tunerName,
            command: result.command,
            samples,
            ...summarize(samples)
        };

        api.responseJSON(res, body);
    } catch (err) {
        if (res.writableEnded === true) {
            return;
        }
        const { code, reason } = signalErrorStatus(err);
        api.responseError(res, code, reason);
    }
};

get.apiDoc = {
    tags: ["channels"],
    operationId: "getChannelSignal",
    description:
        "Measures the signal level of a channel using the tuner's `commandSignal`. " +
        "Requires `commandSignal` to be configured on a tuner that serves this channel.",
    responses: {
        200: {
            description: "OK",
            schema: {
                $ref: "#/definitions/SignalCheckResult"
            }
        },
        404: {
            description: "Not Found",
            schema: {
                $ref: "#/definitions/Error"
            }
        },
        501: {
            description: "Not Configured",
            schema: {
                $ref: "#/definitions/Error"
            }
        },
        503: {
            description: "Tuner Resource Unavailable",
            schema: {
                $ref: "#/definitions/Error"
            }
        },
        default: {
            description: "Unexpected Error",
            schema: {
                $ref: "#/definitions/Error"
            }
        }
    }
};
