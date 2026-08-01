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
import * as stream from "stream";
import _ from "./_";
import * as common from "./common";
import * as apid from "../../api";
import ServiceItem from "./ServiceItem";
import TSFilter from "./TSFilter";
import TLVFilter from "./TLVFilter";

export default class ChannelItem {
    readonly name: string;
    readonly type: apid.ChannelType;
    readonly channel: string;
    readonly satellite?: string;
    readonly space?: number;
    readonly freq?: number;
    readonly polarity?: "H" | "V";
    readonly tsmfRelTs: number;
    readonly commandVars: apid.ConfigChannelsItem["commandVars"];
    allowedTuners: string[] | undefined;
    #configuredAllowedTuners: string[] | undefined;
    #remoteAllowedTuners: string[] | undefined;

    constructor(config: apid.ConfigChannelsItem) {
        this.name = config.name;
        this.type = config.type;
        this.channel = config.channel;
        this.satellite = config.satellite;
        this.space = config.space;
        this.freq = config.freq;
        this.polarity = config.polarity;
        this.tsmfRelTs = config.tsmfRelTs;
        this.commandVars = config.commandVars;
        this.#configuredAllowedTuners = this._normalizeAllowedTuners(config.allowedTuners);
        this.#remoteAllowedTuners = undefined;
        this._updateAllowedTuners();
    }

    setAllowedTuners(allowedTuners: string[] | undefined): void {
        this.#configuredAllowedTuners = this._normalizeAllowedTuners(allowedTuners);
        this._updateAllowedTuners();
    }

    setRemoteAllowedTuners(allowedTuners: string[] | undefined): void {
        this.#remoteAllowedTuners = allowedTuners === undefined
            ? undefined
            : [...new Set(allowedTuners)];
        this._updateAllowedTuners();
    }

    getServices(): ServiceItem[] {
        return _.service.findByChannel(this);
    }

    getStream(user: common.User, output: stream.Writable): Promise<TSFilter | TLVFilter> {
        return _.tuner.initChannelStream(this, user, output);
    }

    toJSON(): apid.ConfigChannelsItem {
        return {
            type: this.type,
            channel: this.channel,
            name: this.name,
            satellite: this.satellite,
            space: this.space,
            freq: this.freq,
            polarity: this.polarity,
            tsmfRelTs: this.tsmfRelTs,
            commandVars: this.commandVars,
            allowedTuners: this.allowedTuners
        };
    }

    private _normalizeAllowedTuners(allowedTuners: string[] | undefined): string[] | undefined {
        if (!allowedTuners || allowedTuners.length === 0) {
            return undefined;
        }

        return [...new Set(allowedTuners)];
    }

    private _updateAllowedTuners(): void {
        if (this.#remoteAllowedTuners === undefined) {
            this.allowedTuners = this.#configuredAllowedTuners;
        } else if (this.#configuredAllowedTuners === undefined) {
            this.allowedTuners = this.#remoteAllowedTuners;
        } else {
            this.allowedTuners = this.#configuredAllowedTuners.filter(name => this.#remoteAllowedTuners.includes(name));
        }
    }
}
