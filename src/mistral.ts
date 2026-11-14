import { Mistral } from "@mistralai/mistralai";
import { getSettings } from "./store.js";

export const MODEL = "mistral-large-4";

/**
 * Clé effective : variable d'environnement MISTRAL_API_KEY prioritaire,
 * sinon clé enregistrée via la page Paramètres du dashboard (data/settings.json).
 */
export function effectiveApiKey(): string | undefined {
  return process.env.MISTRAL_API_KEY ?? getSettings().apiKey ?? undefined;
}

export function apiKeySource(): "env" | "settings" | "none" {
  if (process.env.MISTRAL_API_KEY) return "env";
  if (getSettings().apiKey) return "settings";
  return "none";
}

let client: Mistral | null = null;

export function getClient(): Mistral {
  const apiKey = effectiveApiKey();
  if (!apiKey) {
    throw new Error(
      "Aucune clé API Mistral configurée. Définissez MISTRAL_API_KEY ou renseignez la clé dans la page Paramètres du dashboard.",
    );
  }
  if (!client) client = new Mistral({ apiKey });
  return client;
}

/** Invalide le client en cache (à appeler après changement de clé). */
export function resetClient(): void {
  client = null;
}

export interface BriefMessage {
  role: "system" | "user";
  content: string;
}

export async function complete(
  messages: BriefMessage[],
): Promise<string> {
  const response = await getClient().chat.complete({ model: MODEL, messages });
  const content = response.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

export function buildBrief(
  task: string,
  previousOutputs: { agentName: string; output: string }[],
): string {
  if (previousOutputs.length === 0) return `Tâche initiale de l'utilisateur :\n${task}`;
  const history = previousOutputs
    .map((p) => `--- Sortie de ${p.agentName} ---\n${p.output}`)
    .join("\n\n");
  return `Tâche initiale de l'utilisateur :\n${task}\n\nSorties des agents précédents :\n${history}`;
}
