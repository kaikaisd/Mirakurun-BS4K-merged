const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");

const {
    resolveConfigValue,
    getRemotePort,
    getRemoteAuthHeaders,
    getRemoteConnection,
    getRemoteChildEnv,
    getRemoteConnectionFromEnv,
    describeRemoteConnection,
    CF_ACCESS_CLIENT_ID_HEADER,
    CF_ACCESS_CLIENT_SECRET_HEADER,
    REMOTE_ENV_TLS,
    REMOTE_ENV_CF_ACCESS_CLIENT_ID,
    REMOTE_ENV_CF_ACCESS_CLIENT_SECRET
} = require("../lib/Mirakurun/remoteClient");

const ID = "1a2b3c4d5e6f.access";
const SECRET = "s3cr3t-value";

describe("[remote-client.spec] Cloudflare Access service token", () => {
    const saved = {};
    beforeEach(() => {
        for (const k of ["CF_ID", "CF_SECRET"]) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });
    afterEach(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = v;
            }
        }
    });

    it("sends both service token headers", () => {
        const { headers } = getRemoteAuthHeaders({
            remoteMirakurunCfAccessClientId: ID,
            remoteMirakurunCfAccessClientSecret: SECRET
        });
        assert.strictEqual(headers[CF_ACCESS_CLIENT_ID_HEADER], ID);
        assert.strictEqual(headers[CF_ACCESS_CLIENT_SECRET_HEADER], SECRET);
    });

    it("sends nothing when only one half is configured", () => {
        // a lone id or secret is never a valid token; sending one would just leak it
        assert.deepStrictEqual(getRemoteAuthHeaders({ remoteMirakurunCfAccessClientId: ID }).headers, {});
        assert.deepStrictEqual(getRemoteAuthHeaders({ remoteMirakurunCfAccessClientSecret: SECRET }).headers, {});
    });

    it("sends no headers when unconfigured", () => {
        assert.deepStrictEqual(getRemoteAuthHeaders({}).headers, {});
    });

    it("reads ${ENV_VAR} references from the environment", () => {
        process.env.CF_ID = ID;
        process.env.CF_SECRET = SECRET;
        const { headers, missingEnv } = getRemoteAuthHeaders({
            remoteMirakurunCfAccessClientId: "${CF_ID}",
            remoteMirakurunCfAccessClientSecret: "${CF_SECRET}"
        });
        assert.deepStrictEqual(missingEnv, []);
        assert.strictEqual(headers[CF_ACCESS_CLIENT_ID_HEADER], ID);
        assert.strictEqual(headers[CF_ACCESS_CLIENT_SECRET_HEADER], SECRET);
    });

    it("reports an unset ${ENV_VAR} instead of sending its literal name", () => {
        const { headers, missingEnv } = getRemoteAuthHeaders({
            remoteMirakurunCfAccessClientId: "${CF_ID}",
            remoteMirakurunCfAccessClientSecret: "${CF_SECRET}"
        });
        assert.deepStrictEqual(missingEnv, ["CF_ID", "CF_SECRET"]);
        assert.deepStrictEqual(headers, {});
    });

    it("treats a plain value as a literal, not an env reference", () => {
        assert.deepStrictEqual(resolveConfigValue(SECRET), { value: SECRET, missingEnv: null });
        // only a whole-string ${VAR} is a reference
        assert.deepStrictEqual(resolveConfigValue("pre${CF_ID}post").value, "pre${CF_ID}post");
    });

    it("defaults to port 443 with TLS and 40772 without", () => {
        assert.strictEqual(getRemotePort({ remoteMirakurunTLS: true }), 443);
        assert.strictEqual(getRemotePort({}), 40772);
        // an explicit port always wins
        assert.strictEqual(getRemotePort({ remoteMirakurunTLS: true, remoteMirakurunPort: 8443 }), 8443);
    });

    it("passes credentials through the environment, never the command line", () => {
        const env = getRemoteChildEnv({
            remoteMirakurunTLS: true,
            remoteMirakurunCfAccessClientId: ID,
            remoteMirakurunCfAccessClientSecret: SECRET
        });
        assert.strictEqual(env[REMOTE_ENV_TLS], "1");
        assert.strictEqual(env[REMOTE_ENV_CF_ACCESS_CLIENT_ID], ID);
        assert.strictEqual(env[REMOTE_ENV_CF_ACCESS_CLIENT_SECRET], SECRET);
    });

    it("round-trips the connection from parent to child", () => {
        const config = {
            remoteMirakurunHost: "tuner.example.com",
            remoteMirakurunTLS: true,
            remoteMirakurunCfAccessClientId: ID,
            remoteMirakurunCfAccessClientSecret: SECRET
        };
        const parent = getRemoteConnection(config);
        const child = getRemoteConnectionFromEnv(
            config.remoteMirakurunHost,
            getRemotePort(config),
            getRemoteChildEnv(config)
        );
        assert.strictEqual(child.host, parent.host);
        assert.strictEqual(child.port, parent.port);
        assert.strictEqual(child.tls, parent.tls);
        assert.deepStrictEqual(child.headers, parent.headers);
    });

    it("yields a plain unauthenticated connection when nothing is configured", () => {
        const child = getRemoteConnectionFromEnv("host", 40772, {});
        assert.strictEqual(child.tls, false);
        assert.deepStrictEqual(child.headers, {});
    });

    it("never puts the secret in the log description", () => {
        const desc = describeRemoteConnection(getRemoteConnection({
            remoteMirakurunHost: "tuner.example.com",
            remoteMirakurunTLS: true,
            remoteMirakurunCfAccessClientId: ID,
            remoteMirakurunCfAccessClientSecret: SECRET
        }));
        assert.match(desc, /^https:\/\/tuner\.example\.com:443/);
        assert.ok(desc.includes("Cloudflare Access"), desc);
        assert.ok(desc.includes(SECRET) === false, "secret must not appear in logs");
        assert.ok(desc.includes(ID) === false, "client id must not appear in logs");
    });
});
