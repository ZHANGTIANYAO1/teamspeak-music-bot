const { Client, generateIdentity } = require('@honeybbq/teamspeak-client');

function escapeTS3(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\//g, "\\/")
    .replace(/ /g, "\\s")
    .replace(/\|/g, "\\p")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function replaceField(cmd, key, value) {
  const escaped = escapeTS3(value);
  const regex = new RegExp(key + "=\\S*");
  if (regex.test(cmd)) return cmd.replace(regex, key + "=" + escaped);
  return cmd;
}

// Version to test - passed via env
const VERSIONS = [
  {
    name: "6.0.0-beta2",
    version: "6.0.0-beta2 [Build: 1737468425]",
    platform: "Windows",
    sign: "b5mySiqYAd4Lv5TZNflW+G5Gk8y7Woo9YnJfHRjmzhUyMdGfF1O7fSGJzmx2Hpe/PKaY2aDuKKD6lSxbLYlKCw==",
  },
  {
    name: "3.?.? wildcard",
    version: "3.?.? [Build: 5680278000]",
    platform: "Windows",
    sign: "DX5NIYLvfJEUjuIbCidnoeozxIDRRkpq3I9vVMBmE9L2qnekOoBzSenkzsg2lC9CMv8K5hkEzhr2TYUYSwUXCg==",
  },
  {
    name: "5.0.0-beta77",
    version: "5.0.0-beta77 [Build: 1702382332]",
    platform: "Windows",
    sign: "Ee6DzP16MUXpdKWjiSY0NGb4thN22/Ks0hwNcaMrWoaadgkM6c5477X0IbGFWVjzTWfjFTEad5noYLUPDWSgCQ==",
  },
  {
    name: "3.6.2 (corrected sign)",
    version: "3.6.2 [Build: 1695203293]",
    platform: "Windows",
    sign: "4BdaZpdgUSMCuIs8qcloJPNxNlJ4o7QKnxMCRO60mSOTtJZyKjOrGLAmeAEtLIJjcjmdSpycMbQOIV92K2vXAw==",
  },
];

const idx = parseInt(process.env.VERSION_IDX || "0");
const V = VERSIONS[idx];

const identity = generateIdentity(8);
const client = new Client(identity, "localhost:9987", "MusicBot", {
  logger: {
    debug: () => {},
    info: (m) => console.log("[INFO]", m),
    warn: (m) => console.log("[WARN]", m),
    error: (m) => console.log("[ERROR]", m),
  },
});

console.log("Testing version: " + V.name + " -> " + V.version);
client.connect().then(() => {
  const handler = client.handler;
  const origSendPacket = handler.sendPacket.bind(handler);
  handler.sendPacket = (pType, data, flags) => {
    if (pType === 2) {
      let str = Buffer.from(data).toString("utf-8");
      if (str.startsWith("clientinit ")) {
        str = replaceField(str, "client_version", V.version);
        str = replaceField(str, "client_platform", V.platform);
        str = replaceField(str, "client_version_sign", V.sign);
        console.log("[PATCHED] version=" + V.version);
        origSendPacket(pType, Buffer.from(str), flags);
        return;
      }
    }
    origSendPacket(pType, data, flags);
  };
  return client.waitConnected();
}).then(() => {
  console.log("SUCCESS! Connected with clientId = " + client.clientID());
  client.disconnect();
  process.exit(0);
}).catch((err) => {
  console.log("ERROR:", err && err.message || err);
  process.exit(1);
});
setTimeout(() => {
  console.log("TIMEOUT - version rejected");
  process.exit(2);
}, 10000);
