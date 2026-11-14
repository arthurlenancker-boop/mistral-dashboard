import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import type { Artifact } from "./store.js";
import { effectiveApiKey } from "./mistral.js";

const DATA_DIR = join(process.cwd(), "data");
const ARTIFACTS_DIR = join(DATA_DIR, "artifacts");
mkdirSync(ARTIFACTS_DIR, { recursive: true });

const VOICE_REF_FILE = join(DATA_DIR, "voice-ref.mp3");

export const TTS_MODEL = process.env.MISTRAL_TTS_MODEL ?? "voxtral-mini-tts-3-0";
/** Nom de voix prédéfinie ou ID de voix clonée enregistrée (prioritaire sur le fichier de référence). */
export const TTS_VOICE = process.env.MISTRAL_TTS_VOICE ?? "";

export function voiceReferencePath(): string | null {
  return existsSync(VOICE_REF_FILE) ? VOICE_REF_FILE : null;
}

export function artifactFilePath(runId: string, name: string): string {
  const safe = normalize(name).replace(/^(\.\.[/\\])+/, "");
  return join(ARTIFACTS_DIR, `${runId}__${safe}`);
}

export function saveArtifactFile(
  runId: string,
  artifact: Artifact,
  data: string | Buffer,
): Artifact {
  const file = artifactFilePath(runId, artifact.name);
  writeFileSync(file, data);
  return artifact;
}

export function readArtifactFile(runId: string, name: string): Buffer | null {
  const file = artifactFilePath(runId, name);
  if (!file.startsWith(ARTIFACTS_DIR) || !existsSync(file)) return null;
  return readFileSync(file);
}

export const ARTIFACT_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function artifactMime(name: string): string {
  return ARTIFACT_MIME[extname(name)] ?? "application/octet-stream";
}

/**
 * Synthèse vocale via l'API Mistral (POST /v1/audio/speech).
 * - voix prédéfinie/clonée enregistrée : champ `voice_id` (MISTRAL_TTS_VOICE)
 * - sinon, clonage zero-shot depuis data/voice-ref.mp3 : champ `ref_audio` (base64)
 * Le SDK installé (1.15.x) n'expose pas encore audio.speech, d'où l'appel REST
 * direct — la clé reste côté serveur.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const apiKey = effectiveApiKey();
  if (!apiKey) throw new Error("Aucune clé API Mistral configurée (voir Paramètres).");
  const input = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!input) throw new Error("Texte vide pour la synthèse vocale");

  const body: Record<string, unknown> = {
    model: TTS_MODEL,
    input,
    response_format: "mp3",
  };
  if (TTS_VOICE) {
    body.voice_id = TTS_VOICE;
  } else {
    const ref = voiceReferencePath();
    if (!ref) throw new Error("Aucune voix : définissez MISTRAL_TTS_VOICE ou placez data/voice-ref.mp3");
    body.ref_audio = readFileSync(ref).toString("base64");
  }

  const res = await fetch("https://api.mistral.ai/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`API speech Mistral: ${res.status} ${await res.text()}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await res.json()) as {
      audio_data?: string;
      audio?: string;
      data?: { b64_audio?: string }[];
    };
    const b64 = data.audio_data ?? data.audio ?? data.data?.[0]?.b64_audio ?? "";
    if (!b64) throw new Error("Réponse TTS sans contenu audio");
    return Buffer.from(b64, "base64");
  }
  return Buffer.from(await res.arrayBuffer());
}
