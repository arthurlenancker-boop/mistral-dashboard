import { Mistral } from "@mistralai/mistralai";

export const MODEL = "mistral-large-4";

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! });

export interface BriefMessage {
  role: "system" | "user";
  content: string;
}

export async function complete(
  messages: BriefMessage[],
): Promise<string> {
  const response = await client.chat.complete({ model: MODEL, messages });
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
