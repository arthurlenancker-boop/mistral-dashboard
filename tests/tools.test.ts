import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTtsChunks } from "../src/tools.js";

test("splitTtsChunks : texte court -> un seul chunk identique", () => {
  const chunks = splitTtsChunks("Bonjour. Ceci est court.");
  assert.deepEqual(chunks, ["Bonjour. Ceci est court."]);
});

test("splitTtsChunks : long texte -> chunks <= TTS_CHUNK_MAX, phrases intactes, rien perdu", () => {
  const sentence = "Une phrase complete de longueur fixe pour tester. "; // ~55 car.
  const text = sentence.repeat(60).trim(); // ~3 300 car. -> plusieurs chunks
  const chunks = splitTtsChunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 1800));
  assert.equal(chunks.join(" "), text);
  assert.ok(chunks.every((c) => c.startsWith("Une phrase"))); // chaque chunk commence au début d'une phrase, phrases jamais coupées au milieu
});

test("splitTtsChunks : phrase unique > max -> decoupe brute", () => {
  const text = "a".repeat(4000);
  const chunks = splitTtsChunks(text);
  assert.deepEqual(chunks, ["a".repeat(1800), "a".repeat(1800), "a".repeat(400)]);
});

test("splitTtsChunks : vide -> []", () => {
  assert.deepEqual(splitTtsChunks(""), []);
});
