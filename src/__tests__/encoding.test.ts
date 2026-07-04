import { describe, expect, it } from "vitest";
import { qoderEncodeBody } from "../encoding.js";

describe("qoderEncodeBody", () => {
  it("matches the Qoder custom base64 transform", () => {
    const encoded = qoderEncodeBody(Buffer.from("hello"));
    expect(encoded).toBe(qoderEncodeBody("hello"));
    expect(encoded).not.toBe(Buffer.from("hello").toString("base64"));
    expect(encoded).not.toContain("=");
  });
});
