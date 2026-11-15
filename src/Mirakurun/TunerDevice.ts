/*
   Copyright 2016 kanreisa

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
import { existsSync } from "fs";
import * as stream from "stream";
import * as util from "util";
import EventEmitter = require("eventemitter3");
import * as common from "./common";
import * as log from "./log";
import * as config from "./config";
import * as apid from "../../api";
import status from "./status";
import Event from "./Event";
import ChannelItem from "./ChannelItem";
import { buildSignalCommand, runSignalCommand, SignalCheckOptions } from "./SignalChecker";
import { getRemoteChildEnv, getRemoteConnection, getRemotePort, describeRemoteConnection } from "./remoteClient";
import TSFilter from "./TSFilter";
import TLVFilter from "./TLVFilter";
import Client, { ProgramsQuery } from "../client";
import { REMOTE_EXIT_CHANNEL_UNAVAILABLE } from "../remoteExitCodes";
import { TSHandoffBuffer, TSHandoffOptions, TSHandoffProbe } from "./TSHandoff";
import type DvbDevice from "./dvb/DvbDevice";
import { parseDvbv5ZapCommand } from "./dvb/dvbv5-zap";
import { DvbChannels, findChannelParams, loadChannelsConf, readChannelsConf } from "./dvb/DvbChannelConf";

const DEFAULT_FAILURE_COOLDOWN_SECONDS = 2;
const REMOTE_STREAM_START_TIMEOUT_MS = 5000;

/** 出力をまとめて書き出すまでに保留する入力の上限 (バイト数とミリ秒) */
const FLUSH_BYTES = 128 * 1024;
const FLUSH_INTERVAL = 50;

/** 最後のユーザーが終了してから、チューナーを止めるまでの時間 (ミリ秒) */
const END_STREAM_DELAY = 3000;
/** DVB デバイスを直接操作する場合に、止めてから frontend を閉じるまでの時間 (ミリ秒) */
const DVB_CLOSE_DELAY = 1000;
/** DVB デバイスの読み出しに失敗した場合に、閉じてから選局し直すまでの時間 (ミリ秒。コマンドのプロセスが終了した場合と同じ) */
const DVB_RESPAWN_DELAY = 1000;
/** DVB デバイスを開けない場合のうち、デバイスがないことを示すエラー */
const DVB_MISSING_DEVICE_ERRORS = ["ENOENT", "ENODEV", "ENXIO"];

// koffi (FFI) は DVB デバイスを直接操作するチューナーがある場合だけ読み込む
let dvbDeviceClass: typeof DvbDevice | null;
function loadDvbDevice(): typeof DvbDevice | null {
    if (dvbDeviceClass === undefined) {
        try {
            dvbDeviceClass = (require("./dvb/DvbDevice") as typeof import("./dvb/DvbDevice")).default;
        } catch (err) {
            log.warn("TunerDevice: DVB device direct access is unavailable (%s)", err.message);
            dvbDeviceClass = null;
        }
    }
    return dvbDeviceClass;
}

export type TunerStartupFailureScope = "channel" | "source";

export class TunerStartupError extends Error {
    constructor(message: string, readonly failureScope: TunerStartupFailureScope) {
        super(message);
    }
}

interface User extends common.User {
    _stream?: TSFilter | TLVFilter | TSHandoffBuffer;
}

/** a stream that supports batched output (`write(chunk, true)` then `flush()`) */
function canFlush(stream: TSFilter | TLVFilter | TSHandoffBuffer): stream is TSFilter {
    return typeof (stream as TSFilter).flush === "function";
}

export interface TunerDeviceStatus {
    readonly index: number;
    readonly name: string;
    readonly types: apid.ChannelType[];
    readonly command: string;
    readonly pid: number;
    readonly users: common.User[];
    readonly isAvailable: boolean;
    readonly isRemote: boolean;
    readonly isFree: boolean;
    readonly isUsing: boolean;
    readonly isFault: boolean;
}

export default class TunerDevice extends EventEmitter {
    private _channel: ChannelItem = null;
    private _command: string = null;
    private _process: child_process.ChildProcess = null;
    private _mmtsDecoderProcess: child_process.ChildProcess = null;
    private _stream: stream.Readable = null;
    private _streamUsesMMTSDecoder = false;

    private _users = new Set<User>();
    private _handoffProbe: TSHandoffProbe = null;

    // 書き出しを保留している入力のバイト数と、保留の期限のタイマー
    private _pendingBytes = 0;
    private _flushTimer: NodeJS.Timeout = null;
    private _flushUsersBound = this._flushUsers.bind(this);

    // spawn してから最初の入力までの時間を計測するための spawn 時刻 (0 は計測済み)
    private _spawnedAt = 0;

    private _endStreamTimer: NodeJS.Timeout = null;

    // dvbv5-zap のコマンドの代わりに、DVB デバイスを直接操作する場合
    private _dvb: DvbDevice = null;
    private _dvbChannelsConfPath: string = null;
    private _dvbChannelByFrequency = false;
    // DVB デバイスで選局してから止めるまでの間 (コマンドのプロセスがある間に相当)
    private _dvbActive = false;
    // 選局の途中で止めた場合に、選局の結果を無視するための世代
    private _dvbGeneration = 0;
    private _dvbCloseTimer: NodeJS.Timeout = null;

    private _isAvailable = true;
    private _isRemote = false;
    private _isFault = false;
    private _fatalCount = 0;
    private _exited = false;
    private _closing = false;
    private _lastDevicePathReady: boolean = null;
    private _cooldownUntil = 0;
    private _lastCooldownLogUntil = 0;
    private _lastDataAt = 0;
    private _commandFailed = false;
    private _checkingSignal = false;

    constructor(private _index: number, private _config: apid.ConfigTunersItem) {
        super();
        this._isRemote = !!this._config.remoteMirakurunHost;
        if (this._isRemote === false && this._config.disableDvbDirect !== true) {
            this._initDvb();
        }
        Event.emit("tuner", "create", this.toJSON());
        log.debug("TunerDevice#%d initialized", this._index);
    }

    get index(): number {
        return this._index;
    }

    get config(): apid.ConfigTunersItem {
        return this._config;
    }

    get channel(): ChannelItem {
        return this._channel;
    }

    get command(): string {
        return this._command;
    }

    get pid(): number {
        return this._process ? this._process.pid : null;
    }

    get users(): User[] {
        return [...this._users].map(user => {
            return {
                id: user.id,
                priority: user.priority,
                agent: user.agent,
                url: user.url,
                disableDecoder: user.disableDecoder,
                disableMMTSDecoder: user.disableMMTSDecoder,
                streamSetting: user.streamSetting,
                streamInfo: user.streamInfo
            };
        });
    }

    get decoder(): string | null {
        if (this._isRemote && this._config.remoteMirakurunDecoder === true) {
            return null;
        }
        return this._config.decoder || null;
    }

    get mmtsDecoder(): string {
        return this._config.mmtsDecoder || null;
    }

    get tlvDecoder(): string {
        return this._config.tlvDecoder || null;
    }

    get isAvailable(): boolean {
        return this._isAvailable;
    }

    get isRemote(): boolean {
        return this._isRemote;
    }

    get isFree(): boolean {
        return this._isAvailable === true && this._checkingSignal === false &&
            this._channel === null && this._users.size === 0;
    }

    get isCheckingSignal(): boolean {
        return this._checkingSignal;
    }

    get signalCommand(): string | null {
        return this._config.commandSignal || null;
    }

    get isUsing(): boolean {
        return this._isAvailable === true && this._channel !== null && this._users.size !== 0;
    }

    get isFault(): boolean {
        return this._isFault;
    }

    get lastDataAt(): number {
        return this._lastDataAt;
    }

    get checkDevicePath(): string {
        return this._config.checkDevicePath || this._config.dvbDevicePath || null;
    }

    private get _isRunning(): boolean {
        return this._dvbActive || this._stream !== null;
    }

    canReuseStream(channel: ChannelItem, disableDecoder: boolean, disableMMTSDecoder = disableDecoder): boolean {
        if (this._channel !== channel) {
            return false;
        }
        if (this._canFanoutMMTSDecoder(channel) === true) {
            return true;
        }

        return this._streamUsesMMTSDecoder === this._shouldUseMMTSDecoder(channel, disableMMTSDecoder);
    }

    getPriority(): number {
        let priority = -2;

        for (const user of this._users) {
            if (user.priority > priority) {
                priority = user.priority;
            }
        }

        return priority;
    }

    canHandoffTo(device: TunerDevice, priority: number): boolean {
        if (this.isUsing === false || this._channel === null) {
            return false;
        }
        if (device.isFree === false || device.config.types.includes(this._channel.type) === false || device.canStartStream(this._channel) === false) {
            return false;
        }
        if (priority >= 0 && this.getPriority() > priority) {
            return false;
        }

        return true;
    }

    canStartStream(channel?: ChannelItem, ignoreAvailability = false): boolean {
        if (ignoreAvailability === false && this._isAvailable === false) {
            return false;
        }
        if (this._checkingSignal === true) {
            return false;
        }
        if (channel && this._config.types.includes(channel.type) === false) {
            return false;
        }
        if (this._cooldownUntil > Date.now()) {
            if (this._lastCooldownLogUntil !== this._cooldownUntil) {
                log.warn(
                    "TunerDevice#%d skipped because it is cooling down for %.1f more seconds",
                    this._index, (this._cooldownUntil - Date.now()) / 1000
                );
                this._lastCooldownLogUntil = this._cooldownUntil;
            }
            return false;
        }

        return this._isDevicePathReady();
    }

    toJSON(): TunerDeviceStatus {
        return {
            index: this._index,
            name: this._config.name,
            types: this._config.types,
            command: this._command,
            pid: this.pid,
            users: this.users,
            isAvailable: this.isAvailable,
            isRemote: this.isRemote,
            isFree: this.isFree,
            isUsing: this.isUsing,
            isFault: this.isFault
        };
    }

    canCheckSignal(channel: ChannelItem): boolean {
        if (this.signalCommand === null) {
            return false;
        }
        if (this._isRemote === true) {
            return false;
        }

        return this.isFree === true && this.canStartStream(channel);
    }

    /**
     * Run the configured signal check command against a channel.
     *
     * The device is leased for the whole check so the tuner manager will not
     * hand it to a stream midway: the command drives the hardware directly and
     * cannot share it.
     */
    async checkSignal(channel: ChannelItem, options: SignalCheckOptions): Promise<string> {
        if (this.signalCommand === null) {
            throw new Error(util.format("TunerDevice#%d has no `commandSignal` configured", this._index));
        }
        if (this._checkingSignal === true) {
            throw new Error(util.format("TunerDevice#%d is already checking signal", this._index));
        }
        if (this.isFree === false) {
            throw new Error(util.format("TunerDevice#%d is not free", this._index));
        }

        const command = buildSignalCommand(this.signalCommand, channel);

        this._checkingSignal = true;
        this._command = command;
        log.info(
            "TunerDevice#%d checking signal for channel `%s` (%s) using `%s`",
            this._index, channel.channel, channel.type, command
        );
        Event.emit("tuner", "update", this.toJSON());

        try {
            // DVB Direct leaves the frontend open after a stream so it can re-tune quickly;
            // the signal command opens the same adapter, so release it first. The lease
            // above already keeps streams off this tuner while it closes.
            if (this._dvb !== null && this._dvb.isOpen === true) {
                clearTimeout(this._dvbCloseTimer);
                this._dvbCloseTimer = null;
                await this._dvb.close().catch(log.error);
            }

            options.onStart?.({ tunerIndex: this._index, tunerName: this._config.name, command });
            await runSignalCommand(command, options);
            return command;
        } finally {
            this._checkingSignal = false;
            this._command = null;
            log.info("TunerDevice#%d finished checking signal", this._index);
            Event.emit("tuner", "update", this.toJSON());
        }
    }

    async kill(): Promise<void> {
        await this._kill(true);
    }

    async startStream(user: User, stream: TSFilter | TLVFilter, channel?: ChannelItem, recoverUnavailable = false): Promise<void> {
        log.debug("TunerDevice#%d start stream for user `%s` (priority=%d)...", this._index, user.id, user.priority);
        let waitForRemoteStream = false;

        if (this._isAvailable === false) {
            if (recoverUnavailable === true && channel) {
                await this._recoverUnavailableForStart(channel);
            } else {
                throw new Error(util.format("TunerDevice#%d is not available", this._index));
            }
        }

        if (!channel && !this._isRunning) {
            throw new Error(util.format("TunerDevice#%d has not stream", this._index));
        }

        let spawning: Promise<void> = null;
        if (channel) {
            if (this._config.types.includes(channel.type) === false) {
                throw new Error(util.format("TunerDevice#%d is not supported for channel type `%s`", this._index, channel.type));
            }

            if (this._isRunning) {
                if (channel.channel !== this._channel.channel) {
                    if (this.canStartStream(channel) === false) {
                        throw new Error(util.format("TunerDevice#%d device path is not available", this._index));
                    }
                    if (user.priority <= this.getPriority()) {
                        throw new Error(util.format("TunerDevice#%d has higher priority user", this._index));
                    }

                    this._clearEndStreamTimer();
                    await this._kill(true);
                    spawning = this._spawn(channel, user.disableMMTSDecoder === true);
                    waitForRemoteStream = this._isRemote;
                } else if (
                    this._canFanoutMMTSDecoder(channel) === false &&
                    this._streamUsesMMTSDecoder !== this._shouldUseMMTSDecoder(channel, user.disableMMTSDecoder === true)
                ) {
                    if (this._users.size !== 0) {
                        throw new Error(util.format("TunerDevice#%d has incompatible decoder mode users", this._index));
                    }
                    this._clearEndStreamTimer();
                    await this._kill(true);
                    spawning = this._spawn(channel, user.disableMMTSDecoder === true);
                    waitForRemoteStream = this._isRemote;
                }
            } else {
                if (this.canStartStream(channel) === false) {
                    throw new Error(util.format("TunerDevice#%d device path is not available", this._index));
                }
                spawning = this._spawn(channel, user.disableMMTSDecoder === true);
                waitForRemoteStream = this._isRemote;
            }
        }

        const streamChannel = channel || this._channel;
        if (streamChannel && this._shouldUseMMTSDecoder(streamChannel, user.disableMMTSDecoder === true) === true) {
            this._openMMTSDecoder();
        }

        log.info("TunerDevice#%d streaming to user `%s` (priority=%d)", this._index, user.id, user.priority);

        this._clearEndStreamTimer();
        user._stream = stream;
        this._users.add(user);
        if (stream.closed === true) {
            this.endStream(user);
        } else {
            stream.once("close", () => this.endStream(user));
        }

        this._updated();

        // DVB デバイスを直接選局する間に、ユーザーのいないチューナーとして他の要求に横取りされないよう、ユーザーを加えてから待つ
        if (spawning !== null) {
            try {
                await spawning;
            } catch (err) {
                if (this._users.has(user)) {
                    this.endStream(user);
                }
                throw err;
            }
        }

        if (waitForRemoteStream === true) {
            try {
                await this._waitForRemoteStream();
            } catch (err) {
                this._users.delete(user);
                if (this._process && this._exited === false && this._closing === false) {
                    await this._kill(true).catch(log.error);
                }
                this._updated();
                throw err;
            }
        }
    }

    endStream(user: User): void {
        if (this._users.has(user) === false) {
            return;
        }

        log.debug("TunerDevice#%d end stream for user `%s` (priority=%d)...", this._index, user.id, user.priority);

        user._stream.end();
        this._users.delete(user);

        if (this._users.size === 0) {
            // 他のユーザーが使い始めた後に、前のタイマーでチューナーを止めないよう 1 つだけ保持する
            this._clearEndStreamTimer();
            this._endStreamTimer = setTimeout(() => {
                this._endStreamTimer = null;
                if (this._users.size === 0 && this._isRunning) {
                    this._kill(true).catch(log.error);
                }
            }, END_STREAM_DELAY);
        }

        log.info("TunerDevice#%d end streaming to user `%s` (priority=%d)", this._index, user.id, user.priority);

        this._updated();
    }

    detachStream(user: User): void {
        if (this._users.has(user) === false) {
            return;
        }

        log.info("TunerDevice#%d detaching user `%s` for handoff", this._index, user.id);

        this._users.delete(user);

        if (this._users.size === 0) {
            // same idle hold as endStream(): a DVB Direct tuner has no process to test,
            // and a viewer joining in the meantime cancels this single shared timer
            this._clearEndStreamTimer();
            this._endStreamTimer = setTimeout(() => {
                this._endStreamTimer = null;
                if (this._users.size === 0 && this._isRunning) {
                    this._kill(true).catch(log.error);
                }
            }, END_STREAM_DELAY);
        }

        this._updated();
    }

    async handoffAllUsersTo(device: TunerDevice, priority: number, options: TSHandoffOptions): Promise<boolean> {
        if (this.canHandoffTo(device, priority) === false) {
            return false;
        }

        const users = [...this._users];
        const serviceUser = users.find(user => user.streamSetting && user.streamSetting.serviceId !== undefined);
        const handoffOptions: TSHandoffOptions = {
            ...options,
            serviceId: serviceUser ? serviceUser.streamSetting.serviceId : undefined
        };
        const oldProbe = new TSHandoffProbe(handoffOptions.serviceId);
        const newBuffer = new TSHandoffBuffer(handoffOptions);
        const tempUser: User = {
            ...users[0],
            id: `${users[0].id}:handoff`,
            priority: this.getPriority()
        };

        log.info(
            "TunerDevice#%d handoff starting to TunerDevice#%d for channel `%s` (%d users)",
            this._index,
            device.index,
            this._channel.name,
            users.length
        );

        this._handoffProbe = oldProbe;

        try {
            await device.startStream(tempUser, newBuffer as any, this._channel);

            const switchPCR = await newBuffer.waitForSwitchPCR(() => oldProbe.lastPCR);
            if (switchPCR === null) {
                throw new Error(util.format(
                    "handoff sync timeout (oldPCR=%s, newPCR=%s, deltaMs=%s)",
                    formatPCR(oldProbe.lastPCR),
                    formatPCR(newBuffer.lastPCR),
                    formatPCRDelta(newBuffer.lastPCR, oldProbe.lastPCR)
                ));
            }

            device.detachStream(tempUser);
            const packets = newBuffer.getPacketsFromPCR(switchPCR) || [];
            const bufferedOutput = packets.length > 0 ? Buffer.concat(packets) : null;

            for (const user of users) {
                const stream = user._stream as TSFilter;
                this.detachStream(user);
                if (bufferedOutput !== null && stream.closed === false) {
                    stream.write(bufferedOutput);
                }
                await device.startStream(user, stream);
            }

            log.info("TunerDevice#%d handoff completed to TunerDevice#%d", this._index, device.index);

            return true;
        } catch (err) {
            log.warn("TunerDevice#%d handoff to TunerDevice#%d failed: %s", this._index, device.index, err.message);
            device.endStream(tempUser);
            if (device._users.size === 0 && device._process) {
                await device._kill(true).catch(log.error);
            }
            return false;
        } finally {
            if (this._handoffProbe === oldProbe) {
                this._handoffProbe = null;
            }
        }
    }

    async getRemotePrograms(query?: ProgramsQuery): Promise<apid.Program[]> {
        if (!this._isRemote) {
            throw new Error(util.format("TunerDevice#%d is not remote device", this._index));
        }

        const connection = getRemoteConnection(this.config);
        for (const name of connection.missingEnv) {
            log.error(
                "TunerDevice#%d remote credential references environment variable `%s`, which is not set",
                this._index, name
            );
        }

        const client = new Client();
        client.host = connection.host;
        client.port = connection.port;
        client.tls = connection.tls;
        client.headers = connection.headers;
        client.userAgent = "Mirakurun (Remote)";

        log.debug("TunerDevice#%d fetching remote programs from %s:%d...", this._index, client.host, client.port);

        const programs = await client.getPrograms(query);

        log.info("TunerDevice#%d fetched %d remote programs", this._index, programs.length);

        return programs;
    }

    private _clearEndStreamTimer(): void {
        clearTimeout(this._endStreamTimer);
        this._endStreamTimer = null;
    }

    /** dvbv5-zap のコマンドを解釈できる場合は、DVB デバイスを直接操作する */
    private _initDvb(): void {
        let options: ReturnType<typeof parseDvbv5ZapCommand>;
        try {
            options = parseDvbv5ZapCommand(this._config.command, this._config.dvbDevicePath);
            if (options === null) {
                return;
            }
            // 読めないチャンネル設定ファイルでは選局のたびに失敗するため、先に読んで確かめる
            loadChannelsConf(options.channelsConfPath);
        } catch (err) {
            // dvbv5-zap なのにコマンドを実行する場合は、選局が遅くなるため警告する
            log.warn("TunerDevice#%d uses the command instead of DVB device direct access (%s)", this._index, err.message);
            return;
        }

        const DvbDeviceClass = loadDvbDevice();
        if (DvbDeviceClass === null) {
            return;
        }

        this._dvb = new DvbDeviceClass(options);
        this._dvbChannelsConfPath = options.channelsConfPath;
        this._dvbChannelByFrequency = options.channelByFrequency;
        this._dvb.on("data", this._streamOnData.bind(this));
        this._dvb.on("overflow", () => {
            log.warn("TunerDevice#%d DVB device buffer overflow", this._index);
        });
        this._dvb.on("error", this._dvbOnError.bind(this));

        log.info("TunerDevice#%d uses DVB device %s directly (frontend=%d, demux=%d)", this._index, this._dvb.path, options.frontend, options.demux);
    }

    private async _spawn(ch: ChannelItem, disableMMTSDecoder = false): Promise<void> {
        if (this._dvb !== null) {
            // DVB Direct tunes ISDB-T / ISDB-S only. BS4K (ISDB-S3, carried as TLV) keeps the
            // command path, so commandBS4K and the MMTS decoder behave as they did before.
            if (ch.type !== "BS4K") {
                return this._spawnDvb(ch);
            }
            // DVB Direct leaves the frontend open after a stream so it can re-tune quickly.
            // The command opens the same adapter and would fail as busy, so close it first,
            // keeping the tuner marked busy meanwhile as _spawnCommandInsteadOfDvb() does.
            if (this._dvb.isOpen === true) {
                clearTimeout(this._dvbCloseTimer);
                this._dvbCloseTimer = null;
                this._dvbActive = true;
                this._channel = ch;
                const generation = ++this._dvbGeneration;
                await this._dvb.close().catch(log.error);
                // stopped while closing: whoever stopped it has cleaned up
                if (generation !== this._dvbGeneration) {
                    return;
                }
                this._dvbActive = false;
            }
        }
        return this._spawnCommand(ch, disableMMTSDecoder);
    }

    private async _spawnCommand(ch: ChannelItem, disableMMTSDecoder = false): Promise<void> {
        log.debug("TunerDevice#%d spawn...", this._index);

        if (this._process) {
            throw new Error(util.format("TunerDevice#%d has process", this._index));
        }

        let cmd: string;

        if (this._isRemote === true) {
            cmd = "node lib/remote";
            cmd += " " + this._config.remoteMirakurunHost;
            cmd += " " + getRemotePort(this._config);
            cmd += " " + common.getTuningChannelType(ch.type);
            cmd += " " + ch.channel;
            if (this._config.remoteMirakurunDecoder === true) {
                cmd += " decode";
            }
            if (this._config.remoteMirakurunAllowNested === true) {
                cmd += " allow-nested";
            }
        } else {
            cmd = ch.type === "BS4K" && this._config.commandBS4K ? this._config.commandBS4K : this._config.command;
        }

        cmd = common.replaceCommandTemplate(cmd, {
            channel: ch.channel,
            type: common.getTuningChannelType(ch.type),
            channelType: ch.type,
            satelite: ch.commandVars?.satellite || "", // deprecated, for backward compatibility
            space: 0, // default value for backward compatibility
            ...ch.commandVars
        });

        const parsed = common.parseCommandForSpawn(cmd);

        const spawnOptions: child_process.SpawnOptions = {};
        if (this._isRemote === true) {
            const connection = getRemoteConnection(this._config);
            for (const name of connection.missingEnv) {
                log.error(
                    "TunerDevice#%d remote credential references environment variable `%s`, which is not set",
                    this._index, name
                );
            }
            const childEnv = getRemoteChildEnv(this._config);
            if (Object.keys(childEnv).length > 0) {
                // never on the command line: it is published by GET /api/tuners
                spawnOptions.env = { ...process.env, ...childEnv };
            }
            log.debug("TunerDevice#%d remote target is %s", this._index, describeRemoteConnection(connection));
        }

        this._process = child_process.spawn(parsed.command, parsed.args, spawnOptions);
        this._spawnedAt = Date.now();
        this._command = cmd;
        this._channel = ch;
        this._streamUsesMMTSDecoder = false;
        this._lastDataAt = 0;
        this._commandFailed = false;

        if (this._config.dvbDevicePath) {
            const cat = child_process.spawn("cat", [this._config.dvbDevicePath]);

            cat.once("error", (err) => {
                log.error("TunerDevice#%d cat process error `%s` (pid=%d)", this._index, err.name, cat.pid);

                this._kill(false);
            });

            cat.once("close", (code, signal) => {
                log.debug(
                    "TunerDevice#%d cat process has closed with code=%d by signal `%s` (pid=%d)",
                    this._index, code, signal, cat.pid
                );

                if (this._exited === false) {
                    this._kill(false);
                }
            });

            this._process.once("exit", () => cat.kill("SIGKILL"));

            this._stream = cat.stdout;
        } else {
            this._stream = this._process.stdout;
            if (this._shouldUseMMTSDecoder(ch, disableMMTSDecoder) === true) {
                this._openMMTSDecoder();
            }
        }

        this._process.once("exit", () => this._exited = true);

        // 起動に失敗した場合は "error" の後に "close" も発生するため、後処理は 1 回だけにする
        let ended = false;
        const end = () => {
            if (ended) {
                return;
            }
            ended = true;
            this._end();
            setTimeout(this._release.bind(this), this._config.dvbDevicePath ? 1000 : 100);
        };

        this._process.once("error", (err) => {
            log.fatal("TunerDevice#%d process error `%s` (pid=%d)", this._index, err.name, this._process.pid);

            this._commandFailed = true;
            ++this._fatalCount;
            if (this._fatalCount >= 3) {
                log.fatal("TunerDevice#%d has something fault! **RESTART REQUIRED** after fix it.", this._index);

                this._isFault = true;
                this._closing = true;
            }
            end();
        });

        this._process.once("close", (code, signal) => {
            log.info(
                "TunerDevice#%d process has closed with exit code=%d by signal `%s` (pid=%d)",
                this._index, code, signal, this._process.pid
            );

            this._commandFailed = code !== 0 || signal !== null;
            this._startCooldownIfNeeded(code, signal);
            end();
        });

        this._process.stderr.on("data", data => {
            log.debug("TunerDevice#%d > %s", this._index, data.toString().trim());
        });

        // flowing start
        this._stream.on("data", this._streamOnData.bind(this));

        this._updated();
        log.info("TunerDevice#%d process has spawned by command `%s` (pid=%d)", this._index, cmd, this._process.pid);
    }

    private async _spawnDvb(ch: ChannelItem): Promise<void> {
        log.debug("TunerDevice#%d tune...", this._index);

        if (this._dvbActive) {
            throw new Error(util.format("TunerDevice#%d has stream", this._index));
        }

        clearTimeout(this._dvbCloseTimer);
        this._dvbCloseTimer = null;

        this._dvbActive = true;
        this._command = `${this._dvb.path} ${ch.channel}`;
        this._channel = ch;
        this._spawnedAt = Date.now();
        // per-spawn state the command path also resets (see _spawnCommand())
        this._streamUsesMMTSDecoder = false;
        this._lastDataAt = 0;
        this._commandFailed = false;
        this._updated();

        const generation = ++this._dvbGeneration;
        let channels: DvbChannels;
        try {
            channels = await readChannelsConf(this._dvbChannelsConfPath);
        } catch (err) {
            // 起動後にチャンネル設定ファイルを読めなくなった場合は、その選局だけコマンドを実行する (次の選局で読み直す)
            return this._spawnCommandInsteadOfDvb(ch, generation, err);
        }

        try {
            // 設定を読む間に止めた場合は、止めた側で後処理している
            if (generation !== this._dvbGeneration) {
                return;
            }
            await this._dvb.start(findChannelParams(channels, ch.channel, this._dvbChannelsConfPath, this._dvbChannelByFrequency));
        } catch (err) {
            // 選局の途中で止めた場合は、止めた側で後処理している
            if (generation === this._dvbGeneration) {
                log.error("TunerDevice#%d failed to tune by DVB device `%s`", this._index, err.message);

                // コマンドを起動できない場合と同じく、デバイスがない場合だけ数える
                if (err.syscall === "open" && DVB_MISSING_DEVICE_ERRORS.includes(err.code)) {
                    ++this._fatalCount;
                    if (this._fatalCount >= 3) {
                        log.fatal("TunerDevice#%d has something fault! **RESTART REQUIRED** after fix it.", this._index);
                        this._isFault = true;
                    }
                } else {
                    this._fatalCount = 0;
                }

                // 選局の間に合流したユーザーも終了させる
                ++this._dvbGeneration;
                this._closing = true;
                this._end();
                await this._dvb.close().catch(log.error);
                this._release();
            }
            throw err;
        }

        if (generation === this._dvbGeneration) {
            this._fatalCount = 0;
            log.info("TunerDevice#%d has tuned by DVB device %s (channel=%s) in %dms", this._index, this._dvb.path, ch.channel, Date.now() - this._spawnedAt);
        }
    }

    private async _spawnCommandInsteadOfDvb(ch: ChannelItem, generation: number, err: Error): Promise<void> {
        // 設定を読む間に止めた場合は、止めた側で後処理している (後から始めた選局の frontend を閉じないよう、閉じる前に確かめる)
        if (generation !== this._dvbGeneration) {
            return;
        }
        log.warn("TunerDevice#%d uses the command for this tuning because the channels file can not be used (%s)", this._index, err.message);
        // コマンドが DVB デバイスを開けるよう、frontend を閉じる
        await this._dvb.close().catch(log.error);
        // 閉じる間に止めた場合は、止めた側で後処理している
        if (generation !== this._dvbGeneration) {
            return;
        }

        this._dvbActive = false;
        try {
            await this._spawnCommand(ch);
        } catch (err) {
            // 選局に失敗した場合と同じく、選局の間に合流したユーザーも終了させる
            this._closing = true;
            this._end();
            this._release();
            throw err;
        }
    }

    private _dvbOnError(err: Error): void {
        log.error("TunerDevice#%d DVB device read error `%s`", this._index, err.message);

        // 止めている途中であれば、止めた側で後処理している
        if (this._dvbActive === false || this._closing === true) {
            return;
        }

        // 開き直して選局し直す (ユーザーが残っている場合)
        const generation = ++this._dvbGeneration;
        this._isAvailable = false;
        this._updated();
        this._dvb.close().catch(log.error).then(() => {
            // 閉じる間に止めた場合は、止めた側で後処理している
            if (generation !== this._dvbGeneration) {
                return;
            }
            this._end();

            // 読み出しに失敗し続ける場合に、待たずに選局し直し続けないよう、待ってから選局し直す
            setTimeout(() => {
                // 待つ間に止めた場合は、止めた側で後処理している
                if (generation !== this._dvbGeneration) {
                    return;
                }
                this._release();
            }, DVB_RESPAWN_DELAY);
        });
    }

    private _streamOnData(chunk: Buffer): void {
        this._lastDataAt = Date.now();
        if (this._spawnedAt !== 0) {
            log.debug("TunerDevice#%d received first data in %dms after spawn", this._index, Date.now() - this._spawnedAt);
            this._spawnedAt = 0;
        }

        // 入力のたびに書き出さず、全ストリームの出力をまとめて書き出す (書き出しの回数を減らすため)
        // (選局や合流の直後に最初の出力を遅らせないよう、出力を始めるまでは TSFilter がすぐに書き出す)
        if (this._canFanoutMMTSDecoder(this._channel) === true) {
            for (const user of this._users) {
                if (user.disableMMTSDecoder === true) {
                    this._writeUser(user, chunk);
                }
            }
            if (this._mmtsDecoderProcess && this._mmtsDecoderProcess.stdin.writable === true) {
                this._mmtsDecoderProcess.stdin.write(chunk);
            }
        } else {
            for (const user of this._users) {
                this._writeUser(user, chunk);
            }
            if (this._handoffProbe) {
                this._handoffProbe.write(chunk);
            }
        }

        this._pendingBytes += chunk.length;
        if (this._pendingBytes >= FLUSH_BYTES) {
            this._flushUsers();
        } else if (this._flushTimer === null) {
            this._flushTimer = setTimeout(this._flushUsersBound, FLUSH_INTERVAL);
        }
    }

    /**
     * Batched output needs a stream that can flush(): it takes the chunk now and writes it
     * out on flush(). This fork's TLVFilter (BS4K) and TSHandoffBuffer have no flush(), so
     * they keep writing each chunk straight through.
     */
    private _writeUser(user: User, chunk: Buffer): void {
        const stream = user._stream;
        if (canFlush(stream)) {
            stream.write(chunk, true);
        } else {
            stream.write(chunk);
        }
    }

    private _flushUsers(): void {
        clearTimeout(this._flushTimer);
        this._flushTimer = null;
        this._pendingBytes = 0;

        for (const user of this._users) {
            if (canFlush(user._stream)) {
                user._stream.flush();
            }
        }
    }

    private _mmtsDecoderStreamOnData(chunk: Buffer): void {
        for (const user of this._users) {
            if (user.disableMMTSDecoder !== true) {
                user._stream.write(chunk);
            }
        }
        if (this._handoffProbe !== null) {
            this._handoffProbe.write(chunk);
        }
    }

    private _openMMTSDecoder(): void {
        if (this._mmtsDecoderProcess) {
            return;
        }
        if (this._canFanoutMMTSDecoder(this._channel) === false) {
            return;
        }

        const parsedDecoder = common.parseCommandForSpawn(this._config.mmtsDecoder);
        const mmtsDecoderProcess = child_process.spawn(parsedDecoder.command, parsedDecoder.args);
        this._mmtsDecoderProcess = mmtsDecoderProcess;
        this._streamUsesMMTSDecoder = true;

        mmtsDecoderProcess.once("error", (err) => {
            log.error("TunerDevice#%d mmtsDecoder process error `%s` (pid=%d)", this._index, err.name, mmtsDecoderProcess.pid);

            this._kill(false).catch(log.error);
        });

        mmtsDecoderProcess.once("exit", () => {
            mmtsDecoderProcess.stdin.end();
        });

        mmtsDecoderProcess.once("close", (code, signal) => {
            log.debug(
                "TunerDevice#%d mmtsDecoder process has closed with code=%d by signal `%s` (pid=%d)",
                this._index, code, signal, mmtsDecoderProcess.pid
            );

            if (this._exited === false) {
                this._kill(false).catch(log.error);
            }
        });

        mmtsDecoderProcess.stdout.on("data", this._mmtsDecoderStreamOnData.bind(this));
    }

    private _shouldUseMMTSDecoder(ch: ChannelItem, disableMMTSDecoder: boolean): boolean {
        return this._canFanoutMMTSDecoder(ch) === true && disableMMTSDecoder !== true;
    }

    private async _recoverUnavailableForStart(channel: ChannelItem): Promise<void> {
        if (this._config.types.includes(channel.type) === false) {
            throw new Error(util.format("TunerDevice#%d is not supported for channel type `%s`", this._index, channel.type));
        }

        log.warn(
            "TunerDevice#%d is unavailable, but all tuners for `%s` are unavailable; forcing recovery for `%s`",
            this._index,
            channel.type,
            channel.name
        );

        if (this._isFault === true) {
            log.warn("TunerDevice#%d fault state has been cleared for forced recovery", this._index);
            this._isFault = false;
        }

        // the same condition _kill() requires: a DVB Direct tuner runs without a process
        if (this._dvbActive === true || (this._process && this._process.pid)) {
            if (this._closing === true) {
                await new Promise<void>(resolve => this.once("release", resolve));
            } else {
                await this._kill(true);
            }
        }

        this._channel = null;
        this._users.clear();
        this._streamUsesMMTSDecoder = false;
        this._closing = false;
        this._exited = false;
        this._isAvailable = true;

        this._updated();
    }

    private _canFanoutMMTSDecoder(ch: ChannelItem): boolean {
        return !!ch && !this._config.dvbDevicePath && ch.type === "BS4K" && !!this._config.mmtsDecoder;
    }

    private _waitForRemoteStream(): Promise<void> {
        const tunerProcess = this._process;
        const tunerStream = this._stream;

        return new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeout);
                tunerStream.removeListener("data", onData);
                tunerProcess.removeListener("close", onClose);
                tunerProcess.removeListener("error", onError);
            };
            const onData = () => {
                cleanup();
                resolve();
            };
            const onClose = (code: number, signal: NodeJS.Signals | null) => {
                cleanup();
                reject(new TunerStartupError(util.format(
                    "TunerDevice#%d remote stream closed before first data (code=%s, signal=%s)",
                    this._index,
                    code,
                    signal
                ), code === REMOTE_EXIT_CHANNEL_UNAVAILABLE ? "channel" : "source"));
            };
            const onError = (err: Error) => {
                cleanup();
                reject(new TunerStartupError(util.format(
                    "TunerDevice#%d remote stream failed before first data (%s)",
                    this._index,
                    err.message
                ), "source"));
            };
            const timeout = setTimeout(() => {
                cleanup();
                reject(new TunerStartupError(util.format(
                    "TunerDevice#%d remote stream produced no data within %dms",
                    this._index,
                    REMOTE_STREAM_START_TIMEOUT_MS
                ), "channel"));
            }, REMOTE_STREAM_START_TIMEOUT_MS);

            tunerStream.once("data", onData);
            tunerProcess.once("close", onClose);
            tunerProcess.once("error", onError);
        });
    }

    private _isDevicePathReady(): boolean {
        const path = this.checkDevicePath;
        if (!path) {
            return true;
        }

        const ready = existsSync(path);
        if (ready !== this._lastDevicePathReady) {
            if (ready) {
                log.info("TunerDevice#%d preflight device path is available: `%s`", this._index, path);
            } else {
                log.warn("TunerDevice#%d skipped because preflight device path is missing: `%s`", this._index, path);
            }
            this._lastDevicePathReady = ready;
        }

        return ready;
    }

    private _startCooldownIfNeeded(code: number, signal: NodeJS.Signals | null): void {
        const cooldownSeconds = this._config.cooldownSeconds ?? DEFAULT_FAILURE_COOLDOWN_SECONDS;
        if (this._closing === true || cooldownSeconds <= 0) {
            return;
        }
        if (code === 0 && signal === null) {
            return;
        }

        this._cooldownUntil = Date.now() + cooldownSeconds * 1000;
        log.warn(
            "TunerDevice#%d cooling down for %d seconds after command failure",
            this._index, cooldownSeconds
        );
    }

    private _end(): void {
        this._flushUsers();
        this._isAvailable = false;

        this._stream?.removeAllListeners("data");

        if (this._closing === true) {
            for (const user of this._users) {
                user._stream.end();
            }
            this._users.clear();
        }

        this._updated();
    }

    private async _kill(close: boolean): Promise<void> {
        log.debug("TunerDevice#%d kill...", this._index);

        if (this._dvbActive === false && (!this._process || !this._process.pid)) {
            throw new Error(util.format("TunerDevice#%d has not process", this._index));
        } else if (this._closing) {
            log.debug("TunerDevice#%d return because it is closing", this._index);
            return;
        }

        this._isAvailable = false;
        this._closing = close;
        this._closeMMTSDecoder();

        this._updated();

        const killedAt = Date.now();
        if (this._dvbActive) {
            // 選局し直す場合に備えて、frontend は開いたまま配信だけを止める
            ++this._dvbGeneration;
            await this._dvb.stopStream().catch(log.error);
            this._end();
            this._release();
            log.debug("TunerDevice#%d released in %dms after kill", this._index, Date.now() - killedAt);
            return;
        }

        await new Promise<void>(resolve => {
            this.once("release", resolve);

            if (/^dvbv5-zap /.test(this._command) === true) {
                this._process.kill("SIGKILL");
            } else {
                const timer = setTimeout(() => {
                    log.warn("TunerDevice#%d will force killed because SIGTERM timed out...", this._index);
                    this._process.kill("SIGKILL");
                }, 6000);
                this._process.once("exit", () => clearTimeout(timer));

                // regular way
                this._process.kill("SIGTERM");
            }
        });
        log.debug("TunerDevice#%d released in %dms after kill", this._index, Date.now() - killedAt);
    }

    private _release(): void {
        if (this._process) {
            this._process.stderr.removeAllListeners();
            this._process.removeAllListeners();
        }
        if (this._stream) {
            this._stream.removeAllListeners();
        }
        this._closeMMTSDecoder();

        const dvbReleased = this._dvbActive;
        this._command = null;
        this._process = null;
        this._stream = null;
        this._dvbActive = false;

        if (this._closing === false && this._users.size !== 0) {
            if (this._commandFailed === true || this._isRemote === true) {
                log.warn("TunerDevice#%d stream failed; ending users instead of respawning on the same tuner", this._index);
                this.emit("streamFailure", this._channel);
                for (const user of this._users) {
                    user._stream.end();
                }
                this._users.clear();
            } else {
                log.warn("TunerDevice#%d respawning because request has not closed", this._index);
                ++status.errorCount.tunerDeviceRespawn;

                // 残ったユーザーが使い続けるため、_end() で使用不可にしたチューナーを戻す (他のユーザーも合流できるように)
                if (this._isFault === false) {
                    this._isAvailable = true;
                }

                const users = [...this._users];
                const disableMMTSDecoder = users.length > 0 && users.every(user => user.disableMMTSDecoder === true);
                this._spawn(this._channel, disableMMTSDecoder).catch(err => {
                    log.error("TunerDevice#%d respawn failed `%s`", this._index, err.message);

                    // DVB デバイスの選局に失敗した場合は _spawnDvb() の中で後処理しているため、コマンドを起動できずにユーザーが残った場合だけ終了させる
                    if (this._isRunning === false && this._users.size !== 0 && this._closing === false) {
                        this._closing = true;
                        this._end();
                        this._release();
                    }
                });
                return;
            }
        }

        // DVB デバイスを直接操作する場合は、選局に成功した時点で戻す (選局の失敗を数え続けるため)
        if (dvbReleased === false) {
            this._fatalCount = 0;
        }
        this._channel = null;
        this._users.clear();
        this._streamUsesMMTSDecoder = false;

        if (this._isFault === false) {
            this._isAvailable = true;
        }

        this._closing = false;
        this._exited = false;

        if (this._dvb !== null && this._dvb.isOpen) {
            clearTimeout(this._dvbCloseTimer);
            this._dvbCloseTimer = setTimeout(() => {
                this._dvbCloseTimer = null;
                if (this._dvbActive === false) {
                    this._dvb.close().catch(log.error);
                }
            }, DVB_CLOSE_DELAY);
        }

        this.emit("release");

        log.info("TunerDevice#%d released", this._index);

        this._updated();
    }

    private _closeMMTSDecoder(): void {
        if (!this._mmtsDecoderProcess) {
            return;
        }

        this._mmtsDecoderProcess.stdout.removeAllListeners("data");
        if (this._mmtsDecoderProcess.stdin.writable === true) {
            this._mmtsDecoderProcess.stdin.end();
        }
        this._mmtsDecoderProcess.kill("SIGTERM");
        this._mmtsDecoderProcess = null;
        this._streamUsesMMTSDecoder = false;
    }

    private _updated(): void {
        Event.emit("tuner", "update", this.toJSON());
    }
}

function formatPCR(pcr: number): string {
    return pcr === null || pcr === undefined ? "null" : pcr.toString(10);
}

function formatPCRDelta(left: number, right: number): string {
    if (left === null || left === undefined || right === null || right === undefined) {
        return "null";
    }

    return ((left - right) / 27000).toFixed(1);
}
