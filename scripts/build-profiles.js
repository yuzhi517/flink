const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const PARENT = path.resolve(ROOT, "..");
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

function buildConfig(sg6, sg4, sv6, sv4) {
  const outbounds = [
    parseLink(sg6, "SG-IPv6"),
    parseLink(sg4, "SG-IPv4"),
    parseLink(sv6, "US-IPv6"),
    parseLink(sv4, "US-IPv4"),
    {
      type: "urltest",
      tag: "sg-auto",
      outbounds: ["SG-IPv6", "SG-IPv4"],
      url: "https://www.gstatic.com/generate_204",
      interval: "3m",
      tolerance: 60,
    },
    {
      type: "urltest",
      tag: "us-auto",
      outbounds: ["US-IPv6", "US-IPv4"],
      url: "https://www.gstatic.com/generate_204",
      interval: "3m",
      tolerance: 60,
    },
    { type: "direct", tag: "direct" },
  ];
  return {
    log: { level: "warn", timestamp: true },
    dns: {
      servers: [
        { type: "https", tag: "dns-remote", server: "1.1.1.1", detour: "sg-auto" },
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
    outbounds,
    route: {
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
        { ip_is_private: true, outbound: "direct" },
      ],
      final: "sg-auto",
      auto_detect_interface: true,
      default_domain_resolver: "dns-remote",
    },
  };
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const group = (n) =>
    Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  return `FLK-${group(4)}-${group(4)}-${group(4)}`;
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

function linesWithLinks(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("vless://"));
}

function readTagged(file, prefix) {
  const map = new Map();
  for (const line of linesWithLinks(file)) {
    const index = line.indexOf("vless://");
    const namePart = line.slice(0, index).replace(/^#\s*/, "").trim().replace(/:$/, "");
    const tag = namePart || `${prefix}-${map.size + 1}`;
    map.set(tag, line.slice(index));
  }
  return map;
}

const codesPath = path.join(PARENT, "flink-codes.txt");
const existingCodes = new Map();
if (fs.existsSync(codesPath)) {
  for (const line of fs.readFileSync(codesPath, "utf8").split(/\r?\n/)) {
    const [name, code] = line.split("\t");
    if (name && code) existingCodes.set(name.trim(), code.trim());
  }
}

const sg6Map = readTagged(path.join(PARENT, "vpn-users-sg-ipv6.txt"), "SG6");
const sg4Map = readTagged(path.join(PARENT, "vpn-users.txt"), "SG");
const sv6Map = readTagged(path.join(PARENT, "vpn-users-sv-ipv6.txt"), "SV6");
const sv4Map = readTagged(path.join(PARENT, "vpn-users-sv.txt"), "SV");

const profiles = {};
const codes = [];
for (let i = 1; i <= 5; i += 1) {
  const name = `家人 ${i}`;
  const code = existingCodes.get(name) || makeCode();
  const config = buildConfig(
    sg6Map.get(`SG6-${i}`),
    sg4Map.get(`SG-${i}`),
    sv6Map.get(`SV6-${i}`),
    sv4Map.get(`SV-${i}`),
  );
  profiles[`family${i}`] = { name, ...encrypt(code, config) };
  codes.push(`${name}\t${code}`);
}

fs.writeFileSync(path.join(ROOT, "profiles.json"), JSON.stringify(profiles, null, 2));
fs.writeFileSync(codesPath, `${codes.join("\n")}\n`, { mode: 0o600 });
console.log(`Wrote ${Object.keys(profiles).length} encrypted profiles with SG + US.`);
console.log(codes.map((line) => line.split("\t")[0]).join(", "));
