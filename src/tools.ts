import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { DATA_DIR, type Artifact } from "./store.js";
import { effectiveApiKey } from "./mistral.js";

const ARTIFACTS_DIR = join(DATA_DIR, "artifacts");
mkdirSync(ARTIFACTS_DIR, { recursive: true });

const VOICE_REF_FILE = join(DATA_DIR, "voice-ref.mp3");

export const TTS_MODEL = process.env.MISTRAL_TTS_MODEL ?? "voxtral-mini-tts-3-0";
/** Nom de voix prédéfinie ou ID de voix clonée enregistrée (prioritaire sur le fichier de référence). */
export const TTS_VOICE = process.env.MISTRAL_TTS_VOICE ?? "";

export function voiceReferencePath(): string | null {
  return existsSync(VOICE_REF_FILE) ? VOICE_REF_FILE : null;
}

const MAX_VOICE_REF_BYTES = 25 * 1024 * 1024;

/** Remplace la voix de référence (clonage zero-shot) par un MP3/WAV uploadé. */
export function saveVoiceReference(filename: string, b64: string): number {
  const ext = extname(filename).toLowerCase();
  if (ext !== ".mp3" && ext !== ".wav") {
    throw new Error("Format non supporté : Fournissez un .mp3 ou .wav");
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0 || buf.length > MAX_VOICE_REF_BYTES) {
    throw new Error("Fichier audio vide ou trop volumineux (25 Mo max)");
  }
  writeFileSync(VOICE_REF_FILE, buf);
  return buf.length;
}

const COURSES_DIR = join(DATA_DIR, "courses");
mkdirSync(COURSES_DIR, { recursive: true });

const MAX_COURSE_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_COURSE_FILE_BYTES = 20 * 1024 * 1024;
const COURSE_EXTS = [".md", ".txt", ".pdf", ".jpg", ".jpeg", ".png"];
const OCR_MODEL = process.env.MISTRAL_OCR_MODEL ?? "mistral-ocr-latest";

/** Enregistre le fichier de cours brut et retourne son chemin. */
export function saveCourseFile(name: string, buf: Buffer): string {
  const ext = extname(name).toLowerCase();
  if (!COURSE_EXTS.includes(ext)) {
    throw new Error("Format non supporté : .md, .txt, .pdf, .jpg, .jpeg, .png");
  }
  if (buf.length === 0 || buf.length > MAX_COURSE_FILE_BYTES) {
    throw new Error("Fichier vide ou trop volumineux (20 Mo max)");
  }
  const safe = normalize(name).replace(/^(\.\.[/\\])+/, "").replace(/[^\w.-]/g, "_");
  const file = join(COURSES_DIR, `${Date.now().toString(36)}__${safe}`);
  writeFileSync(file, buf);
  return file;
}

/**
 * Extrait le texte d'un cours : .md/.txt en direct ; .pdf/.jpg/.jpeg/.png via
 * l'API OCR de Mistral (POST /v1/ocr, modèle mistral-ocr-latest).
 */
export async function extractCourseText(
  filename: string,
  buf: Buffer,
  apiKey: string,
): Promise<string> {
  const ext = extname(filename).toLowerCase();
  if (ext === ".md" || ext === ".txt") {
    const text = buf.toString("utf-8");
    if (!text.trim() || text.length > MAX_COURSE_TEXT_BYTES) {
      throw new Error("Cours vide ou trop volumineux (2 Mo max en texte)");
    }
    return text;
  }
  const b64 = buf.toString("base64");
  const document =
    ext === ".pdf"
      ? { type: "document", document: b64, document_name: filename }
      : { type: "image", image: b64 };
  const res = await fetch("https://api.mistral.ai/v1/ocr", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: OCR_MODEL, document }),
  });
  if (!res.ok) {
    throw new Error(`API OCR Mistral: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { pages?: { markdown?: string }[] };
  const text = (data.pages ?? []).map((p) => p.markdown ?? "").join("\n\n");
  if (!text.trim()) throw new Error("Aucun texte extrait par l'OCR");
  return text;
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

/**
 * Supprime tous les fichiers d'artefacts d'une tâche (`<runId>__*`) ; no-op si le
 * dossier des artefacts est absent. Ne jette jamais : un artefact impossible à
 * supprimer (handle ouvert, antivirus…) est consigné et contourné.
 */
export function deleteRunArtifacts(runId: string): void {
  if (!existsSync(ARTIFACTS_DIR)) return;
  for (const name of readdirSync(ARTIFACTS_DIR)) {
    if (!name.startsWith(`${runId}__`)) continue;
    try {
      unlinkSync(join(ARTIFACTS_DIR, name));
    } catch (err) {
      console.warn(`Artefact ${name} non supprimé : ${err instanceof Error ? err.message : err}`);
    }
  }
}

export const ARTIFACT_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function artifactMime(name: string): string {
  return ARTIFACT_MIME[extname(name)] ?? "application/octet-stream";
}

export const TTS_CHUNK_MAX = 1800;

/**
 * Découpe un texte (déjà normalisé par synthesizeSpeech) en groupes de phrases
 * <= TTS_CHUNK_MAX : chaque phrase reste intacte, une phrase seule plus longue
 * que le max est coupée au caractère, un texte vide donne [].
 */
export function splitTtsChunks(text: string): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let buffer = "";
  for (const sentence of text.split(/(?<=[.!?…])\s+/).filter(Boolean)) {
    if (sentence.length > TTS_CHUNK_MAX) {
      if (buffer) {
        chunks.push(buffer);
        buffer = "";
      }
      for (let i = 0; i < sentence.length; i += TTS_CHUNK_MAX) {
        chunks.push(sentence.slice(i, i + TTS_CHUNK_MAX));
      }
      continue;
    }
    const candidate = buffer ? `${buffer} ${sentence}` : sentence;
    if (candidate.length > TTS_CHUNK_MAX) {
      chunks.push(buffer);
      buffer = sentence;
    } else {
      buffer = candidate;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

/**
 * Synthèse vocale via l'API Mistral (POST /v1/audio/speech).
 * - voix prédéfinie/clonée enregistrée : champ `voice_id` (MISTRAL_TTS_VOICE)
 * - sinon, clonage zero-shot depuis data/voice-ref.mp3 : champ `ref_audio` (base64)
 * - texte long : un appel par chunk de phrases (splitTtsChunks), MP3 concaténés
 * Le SDK installé (1.15.x) n'expose pas encore audio.speech, d'où l'appel REST
 * direct — la clé reste côté serveur.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const apiKey = effectiveApiKey();
  if (!apiKey) throw new Error("Aucune clé API Mistral configurée (voir Paramètres).");
  const input = text.replace(/\s+/g, " ").trim();
  if (!input) throw new Error("Texte vide pour la synthèse vocale");
  const chunks = splitTtsChunks(input);

  const body: Record<string, unknown> = {
    model: TTS_MODEL,
    response_format: "mp3",
  };
  if (TTS_VOICE) {
    body.voice_id = TTS_VOICE;
  } else {
    const ref = voiceReferencePath();
    if (!ref) throw new Error("Aucune voix : définissez MISTRAL_TTS_VOICE ou placez data/voice-ref.mp3");
    body.ref_audio = readFileSync(ref).toString("base64");
  }

  const buffers: Buffer[] = [];
  for (const [index, chunk] of chunks.entries()) {
    try {
      const res = await fetch("https://api.mistral.ai/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...body, input: chunk }),
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
        buffers.push(Buffer.from(b64, "base64"));
      } else {
        buffers.push(Buffer.from(await res.arrayBuffer()));
      }
    } catch (err) {
      throw new Error(`Chunk ${index + 1}/${chunks.length} : ${err instanceof Error ? err.message : err}`);
    }
  }
  return Buffer.concat(buffers);
}
