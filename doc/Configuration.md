[**English**](Configuration.md) | [**日本語**](Configuration.ja.md)

# Configuration

- 🗒️[server.yml](#serveryml) - Server Settings
- 🗒️[tuners.yml](#tunersyml) - Tuner Settings
- 🗒️[channels.yml](#channelsyml) - Channel Settings

## ⚠️Security Considerations (FYI)

- Mirakurun is designed to be a LAN-only server.
- By default, access is restricted to private IP addresses.
- Access from arbitrary hostnames or domains is prohibited → **DNS Rebinding / CSRF protection**
  - `hostname`: Set the hostname to access the Web UI.
  - `allowOrigins`: Explicitly set allowed hostnames/domains if required.
- Multiple techniques are used to mitigate attack risks.
- Do not allow API access from all domains or deploy without a reverse proxy, as it may be vulnerable to:
  - Attacks reusing authenticated BASIC credentials or session data.
  - Although modern browsers offer protection, do not rely on them entirely.
  - HTTPS reverse proxies might bypass certain browser and Mirakurun safeguards, increasing risk → [Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)
  - Instead, use VPN, SSH tunnels, or tunnel services.
    - Note: Some tunnel services require configuring `allowIPv4CidrRanges` to prevent third-party access.

> **DNS Rebinding Attack**: An attacker controls a domain and initially serves a legitimate site. After the DNS TTL expires, they switch it to point to their malicious server. This bypasses the browser’s same-origin policy and enables unauthorized access to a LAN server via the browser.

> **XSS/CSRF Attack**: An attacker embeds malicious code into a website to gain unauthorized access to a LAN server via the browser.

- Examples of attacks:
  - Execute arbitrary code via tuner commands
  - Inject malicious code into the server and turn it into a botnet
- The above are only a few examples; many others, exploiting browser or middleware vulnerabilities, are devised daily.
- With more web-based applications emerging, they can be as vulnerable to similar attacks as browsers. Exercise caution.

## 🗒️server.yml

📛 Partially supported in Web UI

### File Paths

- Environment Variable: `SERVER_CONFIG_PATH`
- Docker Host (Default): `/opt/mirakurun/config/server.yml`
- Linux (Legacy): `/usr/local/etc/mirakurun/server.yml`

### Server Settings List

| Property (🗒️server.yml) | Environment Variable (🐋Docker) | Type | Default | Description |
|------------|------------------|-------|-----------|------|
| `logLevel` | `LOG_LEVEL` | Integer | `2` | Log Level (`-1`: FATAL to `3`: DEBUG) |
| `maxLogHistory` | `MAX_LOG_HISTORY` | Integer | `1000` | Maximum number of log lines to retain |
| `path` | - | String, null | 🗒️`/var/run/mirakurun.sock` | Unix Socket Path **※Fixed to default in Docker** |
| `port` | - | Integer, null | `40772` | Server Port **※Fixed at `40772` on the container side in Docker** |
| `hostname` | `HOSTNAME` | String | `localhost` | Hostname |
| `disableIPv6` | - | Boolean | `false` | Disable IPv6 **※Always disabled in Docker** |
| `jobMaxRunning` | `JOB_MAX_RUNNING` | Integer | logical cores / 2, min 1, max 100 | Maximum number of jobs that can run simultaneously |
| `jobMaxStandby` | `JOB_MAX_STANDBY` | Integer | logical cores - 1, min 1, max 100 | Maximum number of jobs that can be prepared simultaneously |
| `maxBufferBytesBeforeReady` | `MAX_BUFFER_BYTES_BEFORE_READY` | Integer | `8388608` | Maximum buffer size before ready (bytes)<br>**※Increase if the beginning of the program is missing** |
| `eventEndTimeout` | `EVENT_END_TIMEOUT` | Integer | `1000` | Event end timeout (milliseconds)<br>**※Increase if program end is incorrectly detected** |
| `programGCJobSchedule` | `PROGRAM_GC_JOB_SCHEDULE` | String | `45 * * * *` | Program list GC schedule (cron-like format) |
| `epgGatheringJobSchedule` | `EPG_GATHERING_JOB_SCHEDULE` | String | `20,50 * * * *` | EPG gathering schedule (cron-like format) |
| `epgRetrievalTime` | `EPG_RETRIEVAL_TIME` | Integer | `600000` | EPG retrieval time (milliseconds) |
| `logoDataInterval` | `LOGO_DATA_INTERVAL` | Integer | `604800000` | Logo data update interval (milliseconds) |
| `tunerHandoff` | - | Object | `{ enabled: false, warmupMs: 0, maxBufferMs: 10000, switchMarginMs: 100, syncTimeoutMs: 5000 }` | Experimental tuner handoff settings for rebalancing occupied tuners with PCR-synchronized buffered switching |
| `disableEITParsing` | `DISABLE_EIT_PARSING` | Boolean | `false` | ⚠️Disable EIT parsing |
| `disableWebUI` | `DISABLE_WEB_UI` | Boolean | `false` | ⚠️Disable Web UI |
| `allowIPv4CidrRanges` | `ALLOW_IPV4_CIDR_RANGES` | String[] | `["10.0.0.0/8", "127.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]` | ⚠️Allowed IPv4 CIDR blocks |
| `allowIPv6CidrRanges` | `ALLOW_IPV6_CIDR_RANGES` | String[] | `["fc00::/7"]` | ⚠️Allowed IPv6 CIDR blocks |
| `allowOrigins` | `ALLOW_ORIGINS` | String[] | `["https://mirakurun-secure-contexts-api.pages.dev"]` | ⚠️🧪Allowed origins (experimental) |
| `allowPNA` | `ALLOW_PNA` | Boolean | `true` | 🧪[PNA](https://github.com/WICG/private-network-access)/[LNA](https://github.com/explainers-by-googlers/local-network-access) permission settings (experimental) |
| `tsplayEndpoint` | `TSPLAY_ENDPOINT` | String | `https://mirakurun-secure-contexts-api.pages.dev/tsplay/` | 🧪TSPlay endpoint (experimental) |

## 🗒️tuners.yml

💯 Fully supported in Web UI

### File Path

- Environment Variable: `TUNERS_CONFIG_PATH`
- Docker Host (Default): `/opt/mirakurun/config/tuners.yml`
- Linux (Legacy): `/usr/local/etc/mirakurun/tuners.yml`

### Structure

```yaml
# Array
- name: TunerIdentificationName # String
  types: # (GR|GR-ALT|BS|CS|SKY|BS4K)[]
    - GR
    - GR-ALT
    - BS
    - CS
    - SKY
    - BS4K
  # For chardev/dvb
  # "<template>" will be replaced with `commandVars[template]` or "(empty)" *@4.0.0~
  command: cmd <channel> --arg1 --arg2 <exampleArg1> <exampleArg2>... # String
  # Optional command used only for BS4K. Falls back to `command` when omitted.
  commandBS4K: cmd-bs4k <channel> --arg1 --arg2 <exampleArg1> <exampleArg2>... # String
  # Optional command used by the signal check page (Web UI: 信号レベル). No default.
  commandSignal: cmd checksignal <channel> # String
  # For dvb
  dvbDevicePath: /dev/dvb/adapter/dvr/path # String
  # Optional preflight path. If omitted, dvbDevicePath is checked when set.
  checkDevicePath: /dev/px4video0 # String
  # Seconds to skip this tuner after its command exits with failure. Defaults to 2.
  cooldownSeconds: 2 # Integer
  # For multiplexing with remote Mirakurun
  remoteMirakurunHost: 192.168.x.x # String
  remoteMirakurunPort: 40772 # Integer
  remoteMirakurunDecoder: false # Boolean
  # Allow the upstream Mirakurun to select another remote tuner. Default: false.
  remoteMirakurunAllowNested: false # Boolean
  # Connect over HTTPS. Required behind a TLS proxy. Changes the default port to 443.
  remoteMirakurunTLS: false # Boolean
  # Cloudflare Access service token. Both are required together, and require remoteMirakurunTLS.
  remoteMirakurunCfAccessClientId: ${CF_ACCESS_CLIENT_ID} # String
  remoteMirakurunCfAccessClientSecret: ${CF_ACCESS_CLIENT_SECRET} # String
  # Optional parameters below
  decoder: cmd # String
  mmtsDecoder: cmd # String
  isDisabled: false # Boolean
```

#### decoder

Specify the CAS processing command as needed.

#### commandBS4K / mmtsDecoder

When a tuner supports `BS4K` together with `BS` / `CS`, specify `commandBS4K` to use a dedicated command for `BS4K` channels. If `commandBS4K` is omitted, `command` is used. Specify `mmtsDecoder` when the `BS4K` command output needs MMTS conversion.

#### remoteMirakurunTLS / Cloudflare Zero Trust

Set `remoteMirakurunTLS: true` to reach the upstream Mirakurun over HTTPS instead of plain HTTP. This is required whenever the upstream is published through a TLS proxy, and it changes the default port from `40772` to `443`.

When the upstream sits behind [Cloudflare Zero Trust](https://developers.cloudflare.com/cloudflare-one/), authenticate with an Access [service token](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/). Mirakurun sends it as the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers on every request to that upstream — the stream, the service scan, the program sync, and the OpenAPI document each request fetches first:

```yaml
- name: RemoteTuner
  types:
    - GR
  remoteMirakurunHost: tuner.example.com
  remoteMirakurunTLS: true
  remoteMirakurunCfAccessClientId: ${CF_ACCESS_CLIENT_ID}
  remoteMirakurunCfAccessClientSecret: ${CF_ACCESS_CLIENT_SECRET}
```

Both halves must be set together, and both require `remoteMirakurunTLS: true`; Access only fronts HTTPS, so over plain HTTP the token would never reach it. Mirakurun refuses to load a tuner that gets this wrong rather than quietly making unauthenticated requests.

**Keep the secret out of this file.** A value written as `${VAR}` is read from that environment variable at load time. This matters because `GET /api/config/tuners` returns the tuners configuration verbatim, so a literal secret here is readable by anyone who can reach the Mirakurun API. With the indirection, the file holds only the variable name:

```sh
CF_ACCESS_CLIENT_ID=1a2b3c....access CF_ACCESS_CLIENT_SECRET=... mirakurun start
```

Only a whole value of the form `${VAR}` is treated as a reference; anything else is used literally. If the variable is unset, Mirakurun logs an error naming it and sends no credentials, rather than transmitting the literal string `${VAR}`.

Credentials are never passed on a command line. The `lib/remote` child process receives them in its environment, because the spawned command is published by `GET /api/tuners` and is visible to other local processes.

#### commandSignal

Specify the command used to measure the signal level of a channel. There is **no default**: supply the command for whichever tuner program you use. The signal check page in the Web UI (and `GET /api/channels/{type}/{channel}/signal`) is unavailable until at least one tuner has this set.

Mirakurun reads the readings from the command's standard output *or* standard error, recognising values by their unit, so the usual tools work without a wrapper:

- `dB`  -> **C/N**, the carrier-to-noise ratio (signal quality)
- `dBm` -> **SIG**, the signal strength (RF power at the tuner input)

```yaml
  # recisdb (https://github.com/kazuki0824/recisdb-rs) -- prints "12.34dB" to stdout
  commandSignal: recisdb checksignal --device /dev/px4video0 --channel <channel>

  # recpt1 (https://github.com/stz2012/recpt1) -- prints "C/N = 30.500000dB" to stderr
  commandSignal: checksignal --device /dev/pt1video0 <channel>

  # dvbv5-zap -- prints both units on one line to stderr:
  #   Lock   (0x1f) Quality= Good Signal= -21.05dBm C/N= 22.50dB UCB= 0 postBER= 0
  commandSignal: dvbv5-zap -a 0 -c /path/to/dvbv5_channels_isdbt.conf -m -t 0 <channel>
```

Whatever the command reports is what the page shows; a command reporting only one of the two leaves the other blank rather than guessing.

C/N is graded (`>= 30` good, `>= 15` fair, below that poor -- the same bands recpt1 uses). **SIG is shown without a verdict on purpose:** a workable input level depends on the tuner's AGC range, and too strong is a real failure mode that an attenuator fixes, so no fixed dBm band would be meaningful across devices. Use it to compare readings on your own hardware -- for example while fitting an attenuator -- and watch what C/N does in response.

Tuners whose driver reports relative rather than absolute stats print percentages (`Signal= 65.00%`) instead of dB/dBm. Those readings are not recognised; nothing is shown rather than a wrong number.

The same template variables as `command` are substituted (`<channel>`, `<type>`, and any `commandVars`). Both commands above run until stopped; Mirakurun terminates the process when the measurement ends or the client disconnects. The tuner is reserved for the duration, so a signal check never runs on a tuner that is streaming.

#### checkDevicePath

Specify a device path that must exist before this tuner can be started. If the path is missing, Mirakurun skips this tuner and tries the next matching tuner. When `checkDevicePath` is omitted, `dvbDevicePath` is used as the preflight path if it is set.

#### cooldownSeconds

Specify seconds to skip this tuner after its command exits with failure. When omitted, it defaults to `2`. Set `0` to disable cooldown.

#### remoteMirakurunAllowNested

Allows the upstream Mirakurun to select another remote tuner. The default is `false`, so only local tuners on the upstream Mirakurun are eligible. Set this to `true` only when a multi-hop remote tuner topology is intentional.

```
# Reference: MPEG-2 TS flow
+-------------+    +----------+    +---------+    +--------+
| TunerDevice | -> | TSFilter | -> | decoder | -> | (user) |
+-------------+    +----------+    +---------+    +--------+
               RAW           STRIPPED      DESCRAMBLED
```

```sh
# This is an implementation example. For testing only.
sudo npm install arib-b25-stream-test -g --unsafe-perm
```

## 🗒️channels.yml

💯 Fully supported in Web UI

### File Path

- Environment Variable: `CHANNELS_CONFIG_PATH`
- Docker Host (Default): `/opt/mirakurun/config/channels.yml`
- Linux (Legacy): `/usr/local/etc/mirakurun/channels.yml`

### Structure

```yaml
# Array
- name: ChannelIdentificationName # String
  type: GR # Enum [GR|GR-ALT|BS|CS|SKY|BS4K]
  channel: '0' # String
  # Optional parameters below
  serviceId: 1234 # Integer - Services will be automatically scanned if not specified.
  tsmfRelTs: 1 # Number: 1~15
  commandVars: # Optional command variables *@4.0.0~
    satellite: EXAMPLE-SAT4A
    space: 0
    freq: 12345
    polarity: H
    exampleArg1: -arg0 -arg1=example
    exampleArg2: -arg2 "Can include spaces using quotes"
  allowedTuners: # Optional tuner name list. If omitted, any matching tuner can be used.
    - Tuner-1
  isDisabled: false # Boolean
```
