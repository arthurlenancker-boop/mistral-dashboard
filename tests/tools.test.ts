import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { splitTtsChunks, deleteRunArtifacts, artifactFilePath } from "../src/tools.js";

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

test("deleteRunArtifacts ne jette jamais : contourne un artefact non supprimable, épargne les autres runs", () => {
  const runId = `run_test_${Math.random().toString(36).slice(2, 8)}`;
  const otherId = `run_test_${Math.random().toString(36).slice(2, 8)}`;
  const mine = artifactFilePath(runId, "voix-off.mp3");
  const other = artifactFilePath(otherId, "voix-off.mp3");
  // un dossier ne peut pas être unlink (EPERM) : simule un artefact bloqué (handle, antivirus…)
  const stuck = join(dirname(mine), `${runId}__dossier`);
  writeFileSync(mine, Buffer.from("x"));
  writeFileSync(other, Buffer.from("x"));
  mkdirSync(stuck);
  try {
    deleteRunArtifacts(runId);
    assert.equal(existsSync(mine), false); // l'artefact supprimable est parti
    assert.equal(existsSync(stuck), true); // le bloqué est contourné, pas fatal
    assert.equal(existsSync(other), true); // les autres runs ne sont pas touchés
  } finally {
    rmSync(stuck, { recursive: true, force: true });
    rmSync(mine, { force: true });
    rmSync(other, { force: true });
  }
});
