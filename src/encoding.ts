const qoderCustomAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const qoderStdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function qoderEncodeBody(plaintext: string | Buffer): string {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString("base64") : Buffer.from(plaintext).toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = "";
  for (let i = 0; i < n; i++) {
    const c = rearranged[i];
    if (c === "=") {
      out += "$";
      continue;
    }
    const idx = qoderStdAlphabet.indexOf(c);
    out += idx >= 0 ? qoderCustomAlphabet[idx] : c;
  }
  return out;
}
