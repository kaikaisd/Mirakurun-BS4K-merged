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
import * as api from "../../../../../api";
import * as apid from "../../../../../../../api";
import _ from "../../../../../_";
import { channelTypes } from "../../../../../common";
import { signalErrorStatus, summarize } from "../signal";
import { SignalSample } from "../../../../../SignalChecker";

const DEFAULT_DURATION = 60;
const MIN_DURATION = 1;
const MAX_DURATION = 600;

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
        description: "seconds to measure for. the stream also ends when the client disconnects."
    }
];

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
    // the command holds the tuner: end it the moment the client goes away
    req.once("close", () => abort.abort());

    let started = false;
    const write = (data: object) => {
        if (res.writableEnded === false) {
            res.write(JSON.stringify(data) + "\n");
        }
    };

    // Headers are held back until the first reading arrives. Tuner selection is
    // what fails when nothing is configured or every tuner is busy, and it only
    // happens inside checkSignal -- deferring lets those failures still be
    // reported as a status code instead of mid-stream.
    const begin = () => {
        if (started === true) {
            return;
        }
        started = true;
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.status(200);
    };

    const samples: SignalSample[] = [];

    try {
        const result = await _.tuner.checkSignal(channel, {
            duration: duration * 1000,
            signal: abort.signal,
            onStart: info => {
                // selection already succeeded here, so deferring headers has done
                // its job and the client can be told which tuner it got
                begin();
                write({ type: "start", ...info });
            },
            onSample: sample => {
                begin();
                samples.push(sample);
                write({ type: "sample", ...sample });
            }
        });

        if (started === false) {
            // the command ran but never reported a level
            api.responseError(res, 500, "signal check reported no level");
            return;
        }

        write({
            type: "end",
            tunerIndex: result.tunerIndex,
            tunerName: result.tunerName,
            command: result.command,
            count: samples.length,
            ...summarize(samples)
        });
    } catch (err) {
        if (started === false) {
            const { code, reason } = signalErrorStatus(err);
            api.responseError(res, code, reason);
            return;
        }
        write({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }

    if (res.writableEnded === false) {
        res.end();
    }
};

get.apiDoc = {
    tags: ["channels"],
    operationId: "getChannelSignalStream",
    description:
        "Streams the check as newline-delimited JSON while it runs. " +
        "A `start` line names the tuner, then one `sample` line per reading " +
        "(`{\"type\":\"sample\",\"time\":<ms>,\"level\":<dB>,\"strength\":<dBm>}`), " +
        "then an `end` line carrying the summary. `level` and `strength` are null when the " +
        "command does not report that unit.",
    produces: ["application/x-ndjson"],
    responses: {
        200: {
            description: "OK"
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
