/*
   Copyright 2018 kanreisa

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
import * as apid from "../api";
import Client from "./client";
import { IncomingMessage } from "http";
import { REMOTE_EXIT_CHANNEL_UNAVAILABLE, REMOTE_EXIT_SOURCE_UNAVAILABLE } from "./remoteExitCodes";
import {
    getRemoteConnectionFromEnv,
    describeRemoteConnection,
    CF_ACCESS_CLIENT_ID_HEADER
} from "./Mirakurun/remoteClient";

process.title = "Mirakurun: Remote";

process.stdin.resume();
process.stdin.on("data", () => exit());
process.on("SIGTERM", () => exit());

const opt = {
    host: process.argv[2],
    port: parseInt(process.argv[3], 10),
    type: process.argv[4] as apid.ChannelType,
    channel: process.argv[5],
    decode: process.argv.includes("decode") === true,
    allowNested: process.argv.includes("allow-nested") === true
};

console.error("remote:", opt);

// the connection arrives in the environment, not argv: the command line is
// published by GET /api/tuners and visible to other local processes
const connection = getRemoteConnectionFromEnv(opt.host, opt.port);

console.error("remote:", "connecting to", describeRemoteConnection(connection));

let stream: IncomingMessage;

const client = new Client();
client.host = connection.host;
client.port = connection.port;
client.tls = connection.tls;
client.headers = connection.headers;
client.userAgent = "Mirakurun (Remote)";

client.getChannelStream({
    type: opt.type,
    channel: opt.channel,
    decode: opt.decode,
    localTunerOnly: opt.allowNested === false
})
    .then(_stream => {
        stream = _stream;
        stream.pipe(process.stdout);
        stream.once("end", () => exit());
    })
    .catch(err => {
        if (err.req) {
            console.error("remote:", "(error)", err.req.path, err.statusCode, err.statusMessage);
            exit(err.statusCode === 404 ? REMOTE_EXIT_CHANNEL_UNAVAILABLE : REMOTE_EXIT_SOURCE_UNAVAILABLE);
        } else if (typeof err.status === "number") {
            // an ErrorResponse from the client: the upstream answered, unhappily
            console.error("remote:", "(error)", err.status, err.statusText);
            if (err.status === 401 || err.status === 403) {
                // the most likely cause once an Access-protected upstream is configured
                console.error(
                    "remote:", "the upstream rejected this request.",
                    connection.headers[CF_ACCESS_CLIENT_ID_HEADER]
                        ? "check that the Cloudflare Access service token is valid and permitted by the application policy."
                        : "if it is published through Cloudflare Zero Trust, set " +
                          "`remoteMirakurunCfAccessClientId` and `remoteMirakurunCfAccessClientSecret`."
                );
            }
            exit(err.status === 404 ? REMOTE_EXIT_CHANNEL_UNAVAILABLE : REMOTE_EXIT_SOURCE_UNAVAILABLE);
        } else {
            console.error("remote:", "(error)", err.address, err.code, err.message || "");
            exit(REMOTE_EXIT_SOURCE_UNAVAILABLE);
        }
    });

function exit(code = 0) {
    console.error("remote:", "exit.");

    if (stream) {
        stream.unpipe();
    }

    process.exit(code);
}
