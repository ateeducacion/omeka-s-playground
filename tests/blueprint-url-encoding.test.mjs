import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import {
  decodeBlueprintParam,
  encodeBlueprintParam,
} from "../src/shared/blueprint.js";

// A repetitive blueprint compresses well, so the gzip branch should win.
const largeBlueprint = {
  siteOptions: {
    title: "Mediateca",
    locale: "es_ES",
    timezone: "Europe/Madrid",
  },
  items: Array.from({ length: 40 }, (_, i) => ({
    title: `Documento de ejemplo número ${i}`,
    description:
      "Un recurso de demostración con metadatos repetidos para la mediateca.",
    creator: "Equipo ATE Educación",
  })),
};

describe("blueprint URL encoding", () => {
  it("round-trips a blueprint through gzip + base64url", async () => {
    const encoded = await encodeBlueprintParam(largeBlueprint);
    assert.equal(typeof encoded, "string");
    // base64url: no +, /, or = padding.
    assert.ok(!/[+/=]/u.test(encoded), "payload must be URL-safe base64url");
    assert.deepEqual(await decodeBlueprintParam(encoded), largeBlueprint);
  });

  it("actually compresses large payloads (gzip magic present, shorter link)", async () => {
    const plain = Buffer.from(JSON.stringify(largeBlueprint), "utf8").toString(
      "base64",
    );
    const encoded = await encodeBlueprintParam(largeBlueprint);
    assert.ok(
      encoded.length < plain.length,
      `gzipped payload (${encoded.length}) should be shorter than plain base64 (${plain.length})`,
    );
    // Decode the base64url back to bytes and confirm the gzip magic header.
    const bytes = Buffer.from(
      encoded.replace(/-/gu, "+").replace(/_/gu, "/"),
      "base64",
    );
    assert.equal(bytes[0], 0x1f);
    assert.equal(bytes[1], 0x8b);
  });

  it("decodes legacy plain-base64 JSON links (backward compatible)", async () => {
    const legacy = { siteOptions: { title: "Legacy" }, items: [] };
    // Old encoder produced standard base64 of UTF-8 JSON (with + / = chars).
    const legacyParam = Buffer.from(JSON.stringify(legacy), "utf8").toString(
      "base64",
    );
    assert.deepEqual(await decodeBlueprintParam(legacyParam), legacy);
  });

  it("round-trips a tiny blueprint even when gzip would not help", async () => {
    const tiny = { items: [] };
    assert.deepEqual(
      await decodeBlueprintParam(await encodeBlueprintParam(tiny)),
      tiny,
    );
  });

  it("rejects empty and invalid payloads", async () => {
    await assert.rejects(() => decodeBlueprintParam(""), /empty/u);
    // Valid base64, but the decoded bytes are not JSON.
    const notJson = Buffer.from("not json {", "utf8").toString("base64");
    await assert.rejects(() => decodeBlueprintParam(notJson), /JSON/u);
  });
});
