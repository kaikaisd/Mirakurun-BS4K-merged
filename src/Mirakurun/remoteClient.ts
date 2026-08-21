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
import * as apid from "../../api";

/**
 * Connecting to a remote Mirakurun published through Cloudflare Zero Trust.
 *
 * Cloudflare Access authenticates non-interactive callers with a service token
 * sent as two headers on every request:
 * https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/
 *
 * Access sits in front of an HTTPS hostname, so `remoteMirakurunTLS` is
 * required as well; without it the request never reaches the proxy.
 */
export const CF_ACCESS_CLIENT_ID_HEADER = "CF-Access-Client-Id";
export const CF_ACCESS_CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";

export const DEFAULT_REMOTE_PORT = 40772;
/** Cloudflare publishes Access applications on the standard HTTPS port. */
export const DEFAULT_REMOTE_TLS_PORT = 443;

/**
 * Environment variables carrying the connection to the `lib/remote` child.
 *
 * The credentials are passed in the environment rather than on the command
 * line on purpose: `TunerDevice#toJSON()` publishes the spawned command
 * through `GET /api/tuners`, and a command line is also visible to any local
 * process, so an argument would leak the secret both ways.
 */
export const REMOTE_ENV_TLS = "MIRAKURUN_REMOTE_TLS";
export const REMOTE_ENV_CF_ACCESS_CLIENT_ID = "MIRAKURUN_REMOTE_CF_ACCESS_CLIENT_ID";
export const REMOTE_ENV_CF_ACCESS_CLIENT_SECRET = "MIRAKURUN_REMOTE_CF_ACCESS_CLIENT_SECRET";

export interface RemoteConnection {
    host: string;
    port: number;
    tls: boolean;
    /** headers to send with every request; empty when no service token is set. */
    headers: { [key: string]: string };
}

export interface ResolvedValue {
    value: string | null;
    /** name of an environment variable that was referenced but is not set. */
    missingEnv: string | null;
}

const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Resolve a configured value, following a `${VAR}` reference to the
 * environment.
 *
 * Indirection matters here: `GET /api/config/tuners` returns the tuners
 * configuration as-is, so a literal secret in `tuners.yml` is readable by
 * anyone who can reach the API. Keeping it in the environment leaves nothing
 * sensitive in the file.
 */
export function resolveConfigValue(value: string | undefined | null): ResolvedValue {
    if (typeof value !== "string" || value === "") {
        return { value: null, missingEnv: null };
    }

    const ref = ENV_REFERENCE.exec(value);
    if (ref === null) {
        return { value, missingEnv: null };
    }

    const name = ref[1];
    const resolved = process.env[name];
    if (typeof resolved !== "string" || resolved === "") {
        return { value: null, missingEnv: name };
    }

    return { value: resolved, missingEnv: null };
}

export function getRemotePort(config: apid.ConfigTunersItem): number {
    if (config.remoteMirakurunPort) {
        return config.remoteMirakurunPort;
    }

    return config.remoteMirakurunTLS === true ? DEFAULT_REMOTE_TLS_PORT : DEFAULT_REMOTE_PORT;
}

/** Build the auth headers, reporting any `${VAR}` that could not be resolved. */
export function getRemoteAuthHeaders(config: apid.ConfigTunersItem): {
    headers: { [key: string]: string };
    missingEnv: string[];
} {
    const headers: { [key: string]: string } = {};
    const missingEnv: string[] = [];

    const id = resolveConfigValue(config.remoteMirakurunCfAccessClientId);
    const secret = resolveConfigValue(config.remoteMirakurunCfAccessClientSecret);

    if (id.missingEnv) {
        missingEnv.push(id.missingEnv);
    }
    if (secret.missingEnv) {
        missingEnv.push(secret.missingEnv);
    }

    // both halves or neither: a lone id or secret is never a valid service token
    if (id.value !== null && secret.value !== null) {
        headers[CF_ACCESS_CLIENT_ID_HEADER] = id.value;
        headers[CF_ACCESS_CLIENT_SECRET_HEADER] = secret.value;
    }

    return { headers, missingEnv };
}

export function getRemoteConnection(config: apid.ConfigTunersItem): RemoteConnection & { missingEnv: string[] } {
    const { headers, missingEnv } = getRemoteAuthHeaders(config);

    return {
        host: config.remoteMirakurunHost,
        port: getRemotePort(config),
        tls: config.remoteMirakurunTLS === true,
        headers,
        missingEnv
    };
}

/** Environment for the `lib/remote` child process, added to the inherited one. */
export function getRemoteChildEnv(config: apid.ConfigTunersItem): { [key: string]: string } {
    const env: { [key: string]: string } = {};
    const { headers } = getRemoteAuthHeaders(config);

    if (config.remoteMirakurunTLS === true) {
        env[REMOTE_ENV_TLS] = "1";
    }
    if (headers[CF_ACCESS_CLIENT_ID_HEADER]) {
        env[REMOTE_ENV_CF_ACCESS_CLIENT_ID] = headers[CF_ACCESS_CLIENT_ID_HEADER];
        env[REMOTE_ENV_CF_ACCESS_CLIENT_SECRET] = headers[CF_ACCESS_CLIENT_SECRET_HEADER];
    }

    return env;
}

/** The child's side of {@link getRemoteChildEnv}. */
export function getRemoteConnectionFromEnv(
    host: string,
    port: number,
    env: NodeJS.ProcessEnv = process.env
): RemoteConnection {
    const headers: { [key: string]: string } = {};
    const id = env[REMOTE_ENV_CF_ACCESS_CLIENT_ID];
    const secret = env[REMOTE_ENV_CF_ACCESS_CLIENT_SECRET];

    if (id && secret) {
        headers[CF_ACCESS_CLIENT_ID_HEADER] = id;
        headers[CF_ACCESS_CLIENT_SECRET_HEADER] = secret;
    }

    return {
        host,
        port,
        tls: env[REMOTE_ENV_TLS] === "1",
        headers
    };
}

/** Describe a connection for logs. Never includes the secret. */
export function describeRemoteConnection(connection: RemoteConnection): string {
    return `${connection.tls === true ? "https" : "http"}://${connection.host}:${connection.port}` +
        (connection.headers[CF_ACCESS_CLIENT_ID_HEADER] ? " (Cloudflare Access service token)" : "");
}
