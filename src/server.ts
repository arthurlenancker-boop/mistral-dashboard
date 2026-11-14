import http from "node:http";
import { readFileSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { join, extname } from "node:path";
import { SEED_AGENTS, type Agent } from "./agents.js";
import {
  getAgents,
  saveAgents,
  getAgent,
  getRuns,
  getRun,
  saveRun,
  newRunId,
  getSettings,
  saveSettings,
  type Run,
  type RunStep,
  type Artifact,
} from "./store.js";
import {
  complete,
  buildBrief,
  getClient,
  resetClient,
  apiKeySource,
  effectiveApiKey,
} from "./mistral.js";
import {
  saveArtifactFile,
  readArtifactFile,
  artifactMime,
  artifactFilePath,
  synthesizeSpeech,
  TTS_MODEL,
  TTS_VOICE,
  voiceReferencePath,
  saveVoiceReference,
  saveCourseFile,
  extractCourseText,
} from "./tools.js";
import { extractRemotionCode, renderVideoToFile } from "./render.js";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = join(process.cwd(), "public");

if (!process.env.MISTRAL_API_KEY && !getSettings().apiKey) {
  console.warn(
    "Avertissement : aucune clé API Mistral. Le serveur démarre mais les appels API échoueront jusqu'à configuration (variable MISTRAL_API_KEY ou page Paramètres du dashboard).",
  );
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

const MAX_BODY_BYTES = 40 * 1024 * 1024; // 40 Mo (uploads base64 inclus)

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Corps de requête trop volumineux (40 Mo max)");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("JSON invalide dans le corps de la requête");
  }
}

function serveStatic(
  res: http.ServerResponse,
  pathname: string,
): boolean {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const path = join(PUBLIC_DIR, file);
  if (!path.startsWith(PUBLIC_DIR) || !existsSync(path)) return false;
  const ext = extname(path);
  const mime = MIME[ext];
  if (!mime) return false;
  res.writeHead(200, { "Content-Type": mime });
  res.end(readFileSync(path));
  return true;
}

/** Agents du pipeline : agents seed, hors agents interactifs, triés par ordre. */
function pipelineAgents(): Agent[] {
  return getAgents()
    .filter((a) => SEED_AGENTS.some((s) => s.id === a.id) && a.inPipeline !== false)
    .sort((a, b) => a.order - b.order);
}

async function runPipeline(run: Run, task: string): Promise<void> {
  const agents = pipelineAgents();
  const previousOutputs: { agentName: string; output: string }[] = [];
  for (const step of run.steps) {
    const agent = agents.find((a) => a.id === step.agentId);
    if (!agent) continue;
    step.status = "running";
    step.startedAt = new Date().toISOString();
    run.updatedAt = step.startedAt;
    saveRun(run);
    try {
      const output = await complete([
        { role: "system", content: agent.systemPrompt },
        { role: "user", content: buildBrief(task, previousOutputs) },
      ]);
      step.status = "done";
      step.output = output;
      previousOutputs.push({ agentName: agent.name, output });
    } catch (err) {
      step.status = "error";
      step.error = err instanceof Error ? err.message : String(err);
      run.status = "error";
      step.endedAt = new Date().toISOString();
      saveRun(run);
      return;
    }
    step.endedAt = new Date().toISOString();
    run.updatedAt = step.endedAt;
    saveRun(run);
  }
  run.status = "done";
  run.updatedAt = new Date().toISOString();
  saveRun(run);
  try {
    await produceArtifacts(run);
  } catch (err) {
    console.error("Erreur production d'artefacts:", err);
  }
}

/**
 * Produit les livrables d'une tâche terminée : transcription JSON complète,
 * voix off MP3 (API speech Mistral) à partir de la sortie de l'agent Voix,
 * et plan de montage Markdown à partir de la sortie de l'agent Monteur.
 * Un échec d'artefact n'échoue pas la tâche.
 */
async function produceArtifacts(run: Run): Promise<void> {
  const artifacts: Artifact[] = [...(run.artifacts ?? [])];
  const outputOf = (name: string) =>
    run.steps.find((s) => s.agentName === name && s.output)?.output ?? "";

  artifacts.push(
    saveArtifactFile(
      run.id,
      { type: "json", name: "transcript.json", label: "Transcription complète (JSON)" },
      JSON.stringify(
        {
          task: run.task,
          status: run.status,
          createdAt: run.createdAt,
          steps: run.steps.map((s) => ({
            agent: s.agentName,
            status: s.status,
            output: s.output ?? null,
            error: s.error ?? null,
          })),
        },
        null,
        2,
      ),
    ),
  );

  const voixText = outputOf("Voix");
  if (voixText) {
    try {
      const audio = await synthesizeSpeech(voixText);
      artifacts.push(
        saveArtifactFile(
          run.id,
          { type: "audio", name: "voix-off.mp3", label: "Voix off (MP3 — API speech Mistral)" },
          audio,
        ),
      );
    } catch (err) {
      artifacts.push({
        type: "audio",
        name: "voix-off.mp3",
        label: "Voix off (MP3 — API speech Mistral)",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const montage = outputOf("Monteur");
  if (montage) {
    artifacts.push(
      saveArtifactFile(
        run.id,
        { type: "text", name: "montage.md", label: "Plan de montage (Markdown)" },
        montage,
      ),
    );
  }

  // Rendu MP4 réel depuis le code Remotion du Monteur (désactivable via RENDER_VIDEO=0)
  if (montage && process.env.RENDER_VIDEO !== "0") {
    const code = extractRemotionCode(montage);
    if (code) {
      try {
        const workDir = join(process.cwd(), "data", "render", run.id);
        const outFile = join(workDir, "video.mp4");
        mkdirSync(workDir, { recursive: true });
        renderVideoToFile(workDir, code, outFile);
        const target = artifactFilePath(run.id, "video.mp4");
        cpSync(outFile, target);
        artifacts.push({ type: "video", name: "video.mp4", label: "Vidéo finale (MP4, rendu Remotion)" });
      } catch (err) {
        console.error("Erreur rendu MP4:", err);
        artifacts.push({
          type: "video",
          name: "video.mp4",
          label: "Vidéo finale (MP4, rendu Remotion)",
          error: err instanceof Error ? err.message.split("\n")[0] : String(err),
        });
      }
    }
  }

  run.artifacts = artifacts;
  saveRun(run);
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? "GET";

  if (pathname === "/api/agents" && method === "GET") {
    json(res, 200, getAgents());
    return true;
  }

  if (pathname === "/api/agents" && method === "POST") {
    const body = await readBody(req);
    if (typeof body.name !== "string" || !body.name.trim()) {
      json(res, 400, { error: "Le champ 'name' est requis" });
      return true;
    }
    const agents = getAgents();
    const agent: Agent = {
      id: `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: String(body.name).trim(),
      role: String(body.role ?? "").trim(),
      order: Number(body.order ?? agents.length + 1),
      systemPrompt: String(body.systemPrompt ?? "Tu es un assistant utile."),
    };
    agents.push(agent);
    saveAgents(agents);
    json(res, 201, agent);
    return true;
  }

  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch) {
    const id = decodeURIComponent(agentMatch[1]);
    if (method === "DELETE") {
      const agents = getAgents();
      const next = agents.filter((a) => a.id !== id);
      if (next.length === agents.length) {
        json(res, 404, { error: `Agent '${id}' introuvable` });
        return true;
      }
      saveAgents(next);
      json(res, 200, { ok: true });
      return true;
    }
  }

  const chatMatch = pathname.match(/^\/api\/agents\/([^/]+)\/chat$/);
  if (chatMatch && method === "POST") {
    const agent = getAgent(decodeURIComponent(chatMatch[1]));
    if (!agent) {
      json(res, 404, { error: "Agent introuvable" });
      return true;
    }
    const body = await readBody(req);
    const history =
      Array.isArray(body.messages) && body.messages.length
        ? body.messages.filter(
            (m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
          )
        : typeof body.message === "string" && body.message.trim()
          ? [{ role: "user", content: String(body.message) }]
          : [];
    if (!history.length) {
      json(res, 400, { error: "Le champ 'message' (ou 'messages') est requis" });
      return true;
    }
    try {
      const answer = await getClient().chat.complete({
        model: "mistral-large-4",
        messages: [{ role: "system", content: agent.systemPrompt }, ...history],
      });
      json(res, 200, {
        reply: answer.choices?.[0]?.message?.content ?? "",
      });
    } catch (err) {
      const status = apiKeySource() === "none" ? 503 : 500;
      json(res, status, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  if (pathname === "/api/settings" && method === "GET") {
    json(res, 200, {
      hasKey: apiKeySource() !== "none",
      source: apiKeySource(),
      ttsModel: TTS_MODEL,
      ttsVoice: TTS_VOICE || null,
      hasVoiceReference: voiceReferencePath() !== null,
    });
    return true;
  }

  if (pathname === "/api/settings" && method === "POST") {
    const body = await readBody(req);
    if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
      json(res, 400, { error: "Le champ 'apiKey' est requis" });
      return true;
    }
    const settings = getSettings();
    settings.apiKey = body.apiKey.trim();
    saveSettings(settings);
    resetClient();
    json(res, 200, { ok: true, source: apiKeySource() });
    return true;
  }

  if (pathname === "/api/settings" && method === "DELETE") {
    const settings = getSettings();
    delete settings.apiKey;
    saveSettings(settings);
    resetClient();
    json(res, 200, { ok: true, source: apiKeySource() });
    return true;
  }

  if (pathname === "/api/settings/voice-ref" && method === "POST") {
    const body = await readBody(req);
    if (typeof body.filename !== "string" || typeof body.contentBase64 !== "string") {
      json(res, 400, { error: "Champs requis : 'filename' et 'contentBase64'" });
      return true;
    }
    try {
      const size = saveVoiceReference(body.filename, body.contentBase64);
      json(res, 200, { ok: true, bytes: size, hasVoiceReference: true });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === "/api/runs" && method === "GET") {
    json(res, 200, getRuns());
    return true;
  }

  if (pathname === "/api/runs" && method === "POST") {
    const body = await readBody(req);
    if (typeof body.task !== "string" || !body.task.trim()) {
      json(res, 400, { error: "Le champ 'task' est requis" });
      return true;
    }
    const task = String(body.task).trim();
    const agents = pipelineAgents();
    const now = new Date().toISOString();
    const steps: RunStep[] = agents.map((a) => ({
      agentId: a.id,
      agentName: a.name,
      status: "pending",
    }));
    const run: Run = {
      id: newRunId(),
      task,
      status: "running",
      createdAt: now,
      updatedAt: now,
      steps,
    };
    let fullTask = task;
    if (body.course && typeof body.course.name === "string" && typeof body.course.contentBase64 === "string") {
      const apiKey = effectiveApiKey();
      if (!apiKey) {
        json(res, 503, { error: "Aucune clé API Mistral configurée (voir Paramètres) — nécessaire pour lire le cours" });
        return true;
      }
      try {
        const courseBuf = Buffer.from(body.course.contentBase64, "base64");
        saveCourseFile(body.course.name, courseBuf);
        const courseText = await extractCourseText(body.course.name, courseBuf, apiKey);
        run.course = body.course.name;
        fullTask = `${task}\n\n=== CONTENU DU COURS (${body.course.name}) ===\n${courseText}`;
        run.artifacts = [
          saveArtifactFile(
            run.id,
            { type: "text", name: body.course.name.replace(/\.[^.]+$/, "") + ".md", label: `Cours source extrait (${body.course.name})` },
            courseText,
          ),
        ];
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return true;
      }
    }
    saveRun(run);
    json(res, 201, run);
    void runPipeline(run, fullTask).catch((err) => {
      run.status = "error";
      run.updatedAt = new Date().toISOString();
      saveRun(run);
      console.error("Erreur pipeline:", err);
    });
    return true;
  }

  const artifactMatch = pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (artifactMatch && method === "GET") {
    const runId = decodeURIComponent(artifactMatch[1]);
    const name = decodeURIComponent(artifactMatch[2]);
    const run = getRun(runId);
    if (!run) {
      json(res, 404, { error: "Run introuvable" });
      return true;
    }
    const content = readArtifactFile(runId, name);
    if (!content) {
      json(res, 404, { error: "Artefact introuvable" });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": artifactMime(name),
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    });
    res.end(content);
    return true;
  }

  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch && method === "GET") {
    const run = getRun(decodeURIComponent(runMatch[1]));
    if (!run) json(res, 404, { error: "Run introuvable" });
    else json(res, 200, run);
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  try {
    if (await handleApi(req, res, pathname)) return;
    if (serveStatic(res, pathname)) return;
    json(res, 404, { error: "Introuvable" });
  } catch (err) {
    json(res, 500, {
      error: err instanceof Error ? err.message : "Erreur interne",
    });
  }
});

server.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
