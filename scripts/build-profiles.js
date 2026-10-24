const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const PARENT = path.resolve(ROOT, "..");
const AUTO_DIR = path.join(PARENT, "auto-sg");
const PORT = 12345;

function parseLink(uri, tag) {
  const url = new URL(uri.trim());
  const p = url.searchParams;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (p.get("security") !== "reality") throw new Error("Only Reality links are supported");
  return {
    type: "vless",
    tag,
    server: host,
    server_port: Number(url.port || 443),
    uuid: decodeURIComponent(url.username),
    flow: p.get("flow") || "xtls-rprx-vision",
    packet_encoding: "xudp",
    tls: {
      enabled: true,
      server_name: p.get("sni") || "www.apple.com",
      utls: { enabled: true, fingerprint: p.get("fp") || "chrome" },
      reality: {
        enabled: true,
        public_key: p.get("pbk"),
        short_id: p.get("sid") || "",
      },
    },
  };
}

function buildConfig(v6, v4) {
  const o6 = parseLink(v6, "SG-IPv6");
  const o4 = parseLink(v4, "SG-IPv4");
  return {
    log: { level: "warn", timestamp: true },
    dns: {
      servers: [
        { type: "https", tag: "dns-remote", server: "1.1.1.1", detour: "auto" },
        { type: "udp", tag: "dns-direct", server: "223.5.5.5" },
      ],
      rules: [{ domain_suffix: [".cn"], server: "dns-direct" }],
      final: "dns-remote",
    },
    inbounds: [
      {
        type: "mixed",
        tag: "mixed-in",
        listen: "127.0.0.1",
        listen_port: PORT,
      },
    ],
    outbounds: [
      o6,
      o4,
      {
        type: "urltest",
        tag: "auto",
        outbounds: ["SG-IPv6", "SG-IPv4"],
        url: "https://www.gstatic.com/generate_204",
        interval: "3m",
        tolerance: 60,
      },
      { type: "direct", tag: "direct" },
    ],
    route: {
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
        { ip_is_private: true, outbound: "direct" },
      ],
      final: "auto",
      auto_detect_interface: true,
      default_domain_resolver: "dns-remote",
    },
  };
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const group = (n) =>
    Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  return `YL-${group(4)}-${group(4)}-${group(4)}`;
}

function encrypt(code, value) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(code, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

const profiles = {};
const codes = [];
for (let i = 1; i <= 5; i += 1) {
  const file = path.join(AUTO_DIR, `SG-Auto-${i}.txt`);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim().startsWith("vless://"));
  if (lines.length < 2) throw new Error(`Expected 2 links in ${file}`);
  const config = buildConfig(lines[0], lines[1]);
  const code = makeCode();
  const name = `家人 ${i}`;
  profiles[`family${i}`] = { name, ...encrypt(code, config) };
  codes.push(`${name}\t${code}`);
}

fs.writeFileSync(path.join(ROOT, "profiles.json"), JSON.stringify(profiles, null, 2));
fs.writeFileSync(path.join(ROOT, "..", "yulink-codes.txt"), `${codes.join("\n")}\n`, { mode: 0o600 });
console.log(`Wrote ${Object.keys(profiles).length} encrypted profiles.`);
console.log(codes.map((line) => line.split("\t")[0]).join(", "));
