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
import * as child_process from "child_process";
import * as common from "./common";
import ChannelItem from "./ChannelItem";
import * as log from "./log";

/**
 * One reading at a point in time.
 *
 * `level` and `strength` measure different things and are reported separately:
 * C/N (dB) is the quality of the demodulated signal, while signal strength
 * (dBm) is the RF power at the tuner input. A tuner can be overdriven -- strong
 * in dBm yet poor in dB -- which is exactly the case an attenuator fixes, so
 * collapsing them into one number would hide the problem.
 *
 * Either may be null: most tools report only one of the two.
 */
export interface SignalSample {
    /** unix time in milliseconds. */
    time: number;
    /** carrier-to-noise ratio in dB, or null when the command does not report it. */
    level: number | null;
    /** signal strength in dBm, or null when the command does not report it. */
    strength: number | null;
}

/**
 * The signal check command is supplied by the user, so its output format is not
 * ours to define. The two common tools both print a decimal followed by `dB`,
 * but agree on nothing else:
 *
 * - recisdb  `checksignal` writes `\r12.34dB` to **stdout**.
 * - recpt1's `checksignal` writes `\rC/N = 30.500000dB ` to **stderr**.
 * - dvbv5-zap `-m` writes a full line to **stderr**, terminated with `\n`:
 *   `Lock   (0x1f) Quality= Good Signal= -21.05dBm C/N= 22.50dB UCB= 0 postBER= 0`
 *
 * The first two never terminate a reading with `\n` -- they redraw a single
 * line with a bare `\r` -- so line-oriented parsing yields nothing at all for
 * them. Both streams are read, and values are extracted wherever they appear.
 *
 * The unit disambiguates the two measurements, so no tool-specific label
 * matching is needed. `dBm` is listed first in the alternation because `dB`
 * would otherwise match the prefix of `-21.05dBm` and report a strength reading
 * as if it were a C/N.
 */
const SIGNAL_LEVEL_REGEXP = /(-?\d+(?:\.\d+)?)\s*(dBm|dB)\b/gi;

/** Discard buffered output beyond this, so a command that never prints a level cannot grow it without bound. */
const MAX_BUFFER_LENGTH = 4096;

/** A reading before it is stamped with a time. */
export interface SignalReading {
    level: number | null;
    strength: number | null;
}

export class SignalLevelParser {
    private _buffer = "";

    /**
     * Feed a chunk of command output and return the readings it completes.
     *
     * Values are grouped into readings so that a single line reporting both
     * units (`Signal= -21.05dBm C/N= 22.50dB`) yields one reading carrying
     * both, not two half-empty ones. A reading ends at a line break, or as soon
     * as the same unit appears twice. A value split across chunks (`"12.3"`
     * then `"4dB"`) is held until complete.
     */
    push(chunk: string): SignalReading[] {
        this._buffer += chunk;

        const readings: SignalReading[] = [];
        let current: SignalReading = { level: null, strength: null };
        let hasCurrent = false;
        let consumed = 0;
        let prevEnd = -1;

        const flush = () => {
            if (hasCurrent === true) {
                readings.push(current);
                current = { level: null, strength: null };
                hasCurrent = false;
            }
        };

        for (const match of this._buffer.matchAll(SIGNAL_LEVEL_REGEXP)) {
            const value = parseFloat(match[1]);
            const isStrength = match[2].length === 3; // "dBm" vs "dB"
            const field = isStrength ? "strength" : "level";

            if (prevEnd >= 0) {
                const between = this._buffer.slice(prevEnd, match.index);
                // a line break, or a repeat of the same unit, starts a new reading
                if (/[\r\n]/.test(between) === true || current[field] !== null) {
                    flush();
                }
            }

            if (Number.isFinite(value) === true) {
                current[field] = value;
                hasCurrent = true;
            }

            prevEnd = match.index + match[0].length;
            consumed = prevEnd;
        }

        flush();

        // keep only the tail after the last complete reading; it may hold a partial one
        this._buffer = this._buffer.slice(consumed);
        if (this._buffer.length > MAX_BUFFER_LENGTH) {
            this._buffer = this._buffer.slice(-MAX_BUFFER_LENGTH);
        }

        return readings;
    }
}

export interface SignalCheckStart {
    readonly tunerIndex: number;
    readonly tunerName: string;
    readonly command: string;
}

export interface SignalCheckOptions {
    /** stop after this many milliseconds. */
    readonly duration: number;
    /**
     * called once the tuner is chosen and the command is built, before it runs.
     * the caller learns which tuner is busy while the check is still going,
     * rather than only after it ends.
     */
    readonly onStart?: (info: SignalCheckStart) => void;
    /** called for every reading as it arrives. */
    readonly onSample: (sample: SignalSample) => void;
    /** resolves early when the caller goes away. */
    readonly signal?: AbortSignal;
}

/**
 * Build the signal check command for a channel, substituting the same template
 * variables as the tuning command.
 */
export function buildSignalCommand(template: string, channel: ChannelItem): string {
    return common.replaceCommandTemplate(template, {
        channel: channel.channel,
        type: common.getTuningChannelType(channel.type),
        channelType: channel.type,
        satelite: channel.commandVars?.satellite || "", // deprecated, for backward compatibility
        space: 0, // default value for backward compatibility
        ...channel.commandVars
    });
}

/**
 * Run a user-supplied signal check command until the duration elapses or the
 * caller aborts, reporting each reading.
 *
 * Both tools loop forever by design, so the command is always terminated by us;
 * exiting on its own before the duration is up means it failed.
 */
export function runSignalCommand(command: string, options: SignalCheckOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let parsed: { command: string; args: string[] };
        try {
            parsed = common.parseCommandForSpawn(command);
        } catch (e) {
            // surface this as a config problem: the command is the user's to write
            reject(new Error(`signal check command is empty or invalid: ${e instanceof Error ? e.message : e}`));
            return;
        }
        if (!parsed.command) {
            reject(new Error("signal check command is empty or invalid"));
            return;
        }

        const parser = new SignalLevelParser();
        let proc: child_process.ChildProcess;
        let finished = false;
        let timer: NodeJS.Timeout;
        let sampleCount = 0;
        let stderrTail = "";

        const cleanup = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            if (proc && proc.exitCode === null && proc.signalCode === null) {
                proc.kill("SIGTERM");
                // the command owns the tuner hardware; do not let it linger if it ignores SIGTERM
                setTimeout(() => {
                    if (proc.exitCode === null && proc.signalCode === null) {
                        proc.kill("SIGKILL");
                    }
                }, 3000).unref();
            }
        };

        const finish = (err?: Error) => {
            if (finished === true) {
                return;
            }
            finished = true;
            cleanup();
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        };

        function onAbort() {
            finish();
        }

        try {
            proc = child_process.spawn(parsed.command, parsed.args);
        } catch (e) {
            reject(e);
            return;
        }

        const onData = (chunk: Buffer) => {
            const time = Date.now();
            for (const reading of parser.push(chunk.toString("utf8"))) {
                ++sampleCount;
                options.onSample({ time, ...reading });
            }
        };

        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", (chunk: Buffer) => {
            // keep the tail for diagnostics -- a command that fails to tune explains itself here
            stderrTail = (stderrTail + chunk.toString("utf8")).slice(-512);
            onData(chunk);
        });

        proc.once("error", (err) => {
            log.error("SignalChecker: command `%s` error `%s`", parsed.command, err.message);
            finish(err);
        });

        proc.once("close", (code, signalCode) => {
            log.debug("SignalChecker: command closed (code=%s, signal=%s, samples=%d)", code, signalCode, sampleCount);
            if (finished === true) {
                return;
            }
            // we always kill it ourselves, so an early exit is a failure
            if (sampleCount === 0) {
                finish(new Error(
                    `signal check command exited (code=${code}) without reporting a level` +
                    (stderrTail.trim() ? `: ${stderrTail.trim()}` : "")
                ));
                return;
            }
            finish();
        });

        timer = setTimeout(() => finish(), options.duration);

        if (options.signal) {
            if (options.signal.aborted === true) {
                finish();
                return;
            }
            options.signal.addEventListener("abort", onAbort, { once: true });
        }
    });
}
