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
import * as React from "react";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
    Button,
    Callout,
    HTMLSelect,
    InputGroup,
    NonIdealState,
    Spinner,
    Switch,
    Tag
} from "@blueprintjs/core";
import { ConfigChannels, ConfigChannelsItem, ConfigTuners, ChannelType } from "../../../api.d";

import "./SignalView.sass";

const typesIndex: ChannelType[] = ["GR", "GR-ALT", "BS", "CS", "SKY", "BS4K"];

/** Readings kept for the sparkline; ~2 minutes at one per second. */
const MAX_HISTORY = 120;

/**
 * Signal quality thresholds, in dB, following the bands recpt1 itself uses for
 * its audible feedback (`recpt1core.c`): >= 30 good, >= 15 fair, below poor.
 *
 * These apply to C/N only. Signal strength in dBm is shown without a verdict:
 * a workable input level depends on the tuner's AGC range, and too strong is a
 * real failure mode (hence attenuators), so no fixed band would be honest.
 */
function levelIntent(level: number): "success" | "warning" | "danger" {
    if (level >= 30) {
        return "success";
    }
    if (level >= 15) {
        return "warning";
    }
    return "danger";
}

function levelLabel(level: number): string {
    if (level >= 30) {
        return "良好";
    }
    if (level >= 15) {
        return "普通";
    }
    return "不良";
}

type Sample = { time: number; level: number | null; strength: number | null };

/** What a finished check leaves behind, so a survey of many channels accumulates. */
type Result = {
    cn: Stat | null;
    sig: Stat | null;
    count: number;
    at: number;
    error?: string;
};

type Stat = { min: number; max: number; avg: number; last: number };

function stat(values: number[]): Stat | null {
    if (values.length === 0) {
        return null;
    }
    return {
        min: Math.min(...values),
        max: Math.max(...values),
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        last: values[values.length - 1]
    };
}

const channelKey = (ch: ConfigChannelsItem) => `${ch.type}/${ch.channel}`;

/**
 * C/N and signal strength are plotted on their own scales: dB readings sit
 * around 0..35, dBm readings are negative, so one shared axis would flatten
 * both. `floor`/`ceil` keep small wobbles from filling the whole box.
 */
const Sparkline: React.FC<{ values: number[]; floor?: number; ceil?: number }> = ({ values, floor, ceil }) => {
    if (values.length < 2) {
        return null;
    }

    const min = Math.min(...(floor === undefined ? values : [floor, ...values]));
    const max = Math.max(...(ceil === undefined ? values : [ceil, ...values]));
    const span = max - min || 1;
    const w = 100;
    const h = 28;

    const points = values.map((v, i) => {
        const x = (i / (values.length - 1)) * w;
        const y = h - ((v - min) / span) * h;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");

    return (
        <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
            <polyline points={points} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
    );
};

export const SignalView: React.FC = () => {
    console.debug("SignalView");

    const [channels, setChannels] = useState<ConfigChannels>(null);
    const [tuners, setTuners] = useState<ConfigTuners>(null);
    const [loadError, setLoadError] = useState<string>(null);

    const [typeFilter, setTypeFilter] = useState<string>("");
    const [query, setQuery] = useState<string>("");
    const [measuredOnly, setMeasuredOnly] = useState<boolean>(false);

    const [activeKey, setActiveKey] = useState<string>(null);
    const [samples, setSamples] = useState<Sample[]>([]);
    const [checkError, setCheckError] = useState<string>(null);
    const [tunerName, setTunerName] = useState<string>(null);
    const [connecting, setConnecting] = useState<boolean>(false);
    const [results, setResults] = useState<{ [key: string]: Result }>({});

    const abortRef = useRef<AbortController>(null);
    const cardRefs = useRef<{ [key: string]: HTMLDivElement }>({});

    useEffect(() => {
        document.title = "信号レベル - Mirakurun";

        (async () => {
            try {
                const [ch, tn] = await Promise.all([
                    fetch("/api/config/channels").then(r => r.json()),
                    fetch("/api/config/tuners").then(r => r.json())
                ]);
                setChannels(ch);
                setTuners(tn);
            } catch (e) {
                setLoadError(e instanceof Error ? e.message : String(e));
            }
        })();

        // never leave a tuner running when the page goes away
        return () => {
            abortRef.current?.abort();
        };
    }, []);

    const stop = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        setActiveKey(null);
        setConnecting(false);
    }, []);

    const start = useCallback((channel: ConfigChannelsItem) => {
        abortRef.current?.abort();

        const key = channelKey(channel);
        const abort = new AbortController();
        abortRef.current = abort;

        setActiveKey(key);
        setSamples([]);
        setCheckError(null);
        setTunerName(null);
        setConnecting(true);

        // keep the running card in view when it is picked from a long list
        window.requestAnimationFrame(() => {
            cardRefs.current[key]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });

        (async () => {
            const collected: Sample[] = [];
            try {
                const res = await fetch(
                    `/api/channels/${channel.type}/${encodeURIComponent(channel.channel)}/signal/stream?duration=600`,
                    { signal: abort.signal }
                );

                if (res.ok === false) {
                    let reason = `HTTP ${res.status}`;
                    try {
                        const body = await res.json();
                        if (body?.reason) {
                            reason = body.reason;
                        }
                    } catch (_) {
                        // non-JSON error body; the status is all we have
                    }
                    setCheckError(reason);
                    setResults(prev => ({
                        ...prev,
                        [key]: { cn: null, sig: null, count: 0, at: Date.now(), error: reason }
                    }));
                    setConnecting(false);
                    setActiveKey(null);
                    return;
                }

                setConnecting(false);

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buf = "";

                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }
                    buf += decoder.decode(value, { stream: true });

                    const lines = buf.split("\n");
                    buf = lines.pop();

                    for (const line of lines) {
                        if (line.trim() === "") {
                            continue;
                        }
                        let msg: any;
                        try {
                            msg = JSON.parse(line);
                        } catch (_) {
                            continue;
                        }
                        if (msg.type === "sample") {
                            const sample: Sample = {
                                time: msg.time,
                                level: msg.level ?? null,
                                strength: msg.strength ?? null
                            };
                            collected.push(sample);
                            setSamples(prev => [...prev, sample].slice(-MAX_HISTORY));
                        } else if (msg.type === "start" || msg.type === "end") {
                            setTunerName(msg.tunerName);
                        } else if (msg.type === "error") {
                            setCheckError(msg.message);
                        }
                    }
                }
            } catch (e) {
                if (abort.signal.aborted === false) {
                    setCheckError(e instanceof Error ? e.message : String(e));
                }
            } finally {
                setConnecting(false);
                if (collected.length > 0) {
                    setResults(prev => ({
                        ...prev,
                        [key]: {
                            cn: stat(collected.map(s => s.level).filter((v): v is number => v !== null)),
                            sig: stat(collected.map(s => s.strength).filter((v): v is number => v !== null)),
                            count: collected.length,
                            at: Date.now()
                        }
                    }));
                }
                setActiveKey(prev => (prev === key ? null : prev));
            }
        })();
    }, []);

    const enabled = useMemo(
        () => (channels || []).filter(ch => ch.isDisabled !== true),
        [channels]
    );

    const groups = useMemo(() => {
        const q = query.trim().toLowerCase();
        const matched = enabled.filter(ch => {
            if (typeFilter && ch.type !== typeFilter) {
                return false;
            }
            if (measuredOnly && !results[channelKey(ch)]) {
                return false;
            }
            if (q === "") {
                return true;
            }
            return ch.channel.toLowerCase().includes(q) || (ch.name || "").toLowerCase().includes(q);
        });

        const byType = new Map<ChannelType, ConfigChannelsItem[]>();
        for (const ch of matched) {
            const list = byType.get(ch.type);
            if (list) {
                list.push(ch);
            } else {
                byType.set(ch.type, [ch]);
            }
        }

        return typesIndex
            .filter(t => byType.has(t))
            .map(t => [t, byType.get(t)] as [ChannelType, ConfigChannelsItem[]]);
    }, [enabled, typeFilter, query, measuredOnly, results]);

    if (loadError) {
        return <div id="route-signal-view">
            <Callout intent="danger" title="読み込みに失敗しました">{loadError}</Callout>
        </div>;
    }

    if (channels === null || tuners === null) {
        return <div id="route-signal-view"><Spinner /></div>;
    }

    const configuredTuners = tuners.filter(t => !!t.commandSignal && t.isDisabled !== true);
    const types = typesIndex.filter(t => enabled.some(ch => ch.type === t));
    const shown = groups.reduce((n, [, list]) => n + list.length, 0);

    const latest = samples.length ? samples[samples.length - 1] : null;
    const cnValues = samples.map(s => s.level).filter((v): v is number => v !== null);
    const sigValues = samples.map(s => s.strength).filter((v): v is number => v !== null);
    const liveCn = stat(cnValues);
    const liveSig = stat(sigValues);
    const hasCN = latest?.level !== null && latest?.level !== undefined;
    const hasSIG = latest?.strength !== null && latest?.strength !== undefined;

    const renderCard = (ch: ConfigChannelsItem) => {
        const key = channelKey(ch);
        const isActive = activeKey === key;
        const result = results[key];

        return (
            <div
                key={key}
                ref={el => { cardRefs.current[key] = el; }}
                className={`signal-card${isActive ? " active" : ""}${result?.error ? " errored" : ""}`}
            >
                <div className="card-head">
                    <Tag minimal className="type">{ch.type}</Tag>
                    <span className="channel">{ch.channel}</span>
                    {isActive && tunerName && <Tag minimal intent="primary" className="tuner">{tunerName}</Tag>}
                </div>
                <div className="card-name" title={ch.name}>{ch.name}</div>

                {isActive
                    ? <div className="card-live">
                        {connecting && <div className="waiting"><Spinner size={16} /> チューナーを起動しています...</div>}
                        {hasCN && (
                            <div className="reading-level">
                                <span className="metric-name">C/N</span>
                                {latest.level.toFixed(2)}<span className="unit">dB</span>
                                <Tag intent={levelIntent(latest.level)}>{levelLabel(latest.level)}</Tag>
                            </div>
                        )}
                        {hasSIG && (
                            <div className={hasCN ? "reading-strength" : "reading-level"}>
                                <span className="metric-name">SIG</span>
                                {latest.strength.toFixed(2)}<span className="unit">dBm</span>
                            </div>
                        )}
                        {latest && <>
                            <Sparkline
                                values={hasCN ? cnValues : sigValues}
                                floor={hasCN ? 0 : undefined}
                                ceil={hasCN ? 35 : undefined}
                            />
                            <div className="card-stats">
                                {liveCn && <span>C/N {liveCn.min.toFixed(2)} 〜 {liveCn.max.toFixed(2)} 平均 {liveCn.avg.toFixed(2)}dB</span>}
                                {liveSig && <span>SIG {liveSig.min.toFixed(2)} 〜 {liveSig.max.toFixed(2)} 平均 {liveSig.avg.toFixed(2)}dBm</span>}
                                <span>{samples.length} 回</span>
                            </div>
                        </>}
                    </div>
                    : <div className="card-result">
                        {result?.error
                            ? <span className="result-error" title={result.error}>{result.error}</span>
                            : result
                                ? <>
                                    {result.cn && (
                                        <span className="result-metric">
                                            <span className="metric-name">C/N</span>
                                            <b>{result.cn.avg.toFixed(2)}</b><span className="unit">dB</span>
                                            <Tag minimal intent={levelIntent(result.cn.avg)}>{levelLabel(result.cn.avg)}</Tag>
                                        </span>
                                    )}
                                    {result.sig && (
                                        <span className="result-metric">
                                            <span className="metric-name">SIG</span>
                                            <b>{result.sig.avg.toFixed(2)}</b><span className="unit">dBm</span>
                                        </span>
                                    )}
                                    {!result.cn && !result.sig && <span className="result-none">値を取得できませんでした</span>}
                                </>
                                : <span className="result-none">未測定</span>
                        }
                    </div>
                }

                <div className="card-actions">
                    {isActive
                        ? <Button small intent="danger" icon="stop" text="停止" onClick={stop} fill />
                        : <Button
                            small
                            icon="satellite"
                            text={result ? "再測定" : "確認"}
                            disabled={configuredTuners.length === 0 || activeKey !== null}
                            onClick={() => start(ch)}
                            fill
                        />
                    }
                </div>
            </div>
        );
    };

    return (
        <div id="route-signal-view">
            <div className="content">
                <h3 className="title">信号レベル</h3>

                {configuredTuners.length === 0 && (
                    <Callout intent="warning" title="信号確認コマンドが未設定です">
                        <p>
                            チューナー設定の <strong>Signal Command</strong> にお使いのチューナープログラムのコマンドを
                            入力してください。設定されるまでこの機能は使用できません。
                        </p>
                        <p className="examples">
                            例: <code>recisdb checksignal --device /dev/px4video0 --channel &lt;channel&gt;</code><br />
                            例: <code>checksignal --device /dev/pt1video0 &lt;channel&gt;</code><br />
                            例: <code>dvbv5-zap -a 0 -c CONF -m -t 0 &lt;channel&gt;</code>
                        </p>
                        <p className="examples">
                            <code>dB</code> は C/N、<code>dBm</code> は信号強度 (SIG) として読み取ります。
                        </p>
                        <Button
                            intent="primary"
                            icon="wrench"
                            text="チューナー設定へ"
                            onClick={() => { location.href = "/config/tuners"; }}
                        />
                    </Callout>
                )}

                {checkError && (
                    <Callout intent="danger" title="信号を確認できませんでした">{checkError}</Callout>
                )}

                <div className="toolbar">
                    <InputGroup
                        leftIcon="search"
                        placeholder="チャンネル・名前で絞り込み..."
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        rightElement={query
                            ? <Button variant="minimal" icon="cross" onClick={() => setQuery("")} />
                            : undefined}
                    />
                    <HTMLSelect
                        value={typeFilter}
                        onChange={(e) => setTypeFilter(e.target.value)}
                        options={[{ label: "すべての種別", value: "" }, ...types.map(t => ({ label: t, value: t }))]}
                    />
                    <Switch
                        checked={measuredOnly}
                        label="測定済みのみ"
                        onChange={(e) => setMeasuredOnly(e.currentTarget.checked)}
                    />
                    <span className="count">{shown} / {enabled.length} チャンネル</span>
                </div>

                {shown === 0
                    ? <NonIdealState
                        icon="search"
                        title="該当するチャンネルがありません"
                        description={enabled.length === 0
                            ? "チャンネル設定でチャンネルを追加してください。"
                            : "絞り込み条件を変更してください。"}
                    />
                    : groups.map(([type, list]) => (
                        <section className="type-group" key={type}>
                            <h4 className="group-head">
                                {type}<span className="group-count">{list.length}</span>
                            </h4>
                            <div className="card-grid">{list.map(renderCard)}</div>
                        </section>
                    ))
                }
            </div>
        </div>
    );
};
