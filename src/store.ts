import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SEED_AGENTS, type Agent } from "./agents.js";

const DATA_DIR = join(process.cwd(), "data");
const AGENTS_FILE = join(DATA_DIR, "agents.json");
const RUNS_FILE = join(DATA_DIR, "runs.json");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

export interface Settings {
  apiKey?: string;
}

export function getSettings(): Settings {
  return load<Settings>(SETTINGS_FILE, {});
}

export function saveSettings(settings: Settings): void {
  save(SETTINGS_FILE, settings);
}

export interface RunStep {
  agentId: string;
  agentName: string;
  status: "pending" | "running" | "done" | "error";
  output?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface Artifact {
  type: "audio" | "json" | "text";
  name: string;
  label: string;
  error?: string;
}

export interface Run {
  id: string;
  task: string;
  status: "running" | "done" | "error";
  createdAt: string;
  updatedAt: string;
  steps: RunStep[];
  artifacts?: Artifact[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function load<T>(file: string, fallback: T): T {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    // corrupted file: fall back to defaults
  }
  return fallback;
}

function save(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2), "utf-8");
}

export function getAgents(): Agent[] {
  return load<Agent[]>(AGENTS_FILE, [...SEED_AGENTS]);
}

export function saveAgents(agents: Agent[]): void {
  save(AGENTS_FILE, agents);
}

export function getAgent(id: string): Agent | undefined {
  return getAgents().find((a) => a.id === id);
}

export function getRuns(): Run[] {
  return load<Run[]>(RUNS_FILE, []);
}

export function getRun(id: string): Run | undefined {
  return getRuns().find((r) => r.id === id);
}

export function saveRun(run: Run): void {
  const runs = getRuns();
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) runs[idx] = run;
  else runs.unshift(run);
  save(RUNS_FILE, runs);
}

export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
