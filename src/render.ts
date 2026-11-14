import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, cpSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");
const RENDER_DIR = join(DATA_DIR, "render");
const TEMPLATE_DIR = join(RENDER_DIR, "template");
mkdirSync(RENDER_DIR, { recursive: true });

export const RENDER_WIDTH = Number(process.env.RENDER_WIDTH ?? 1920);
export const RENDER_HEIGHT = Number(process.env.RENDER_HEIGHT ?? 1080);
export const RENDER_FPS = Number(process.env.RENDER_FPS ?? 30);
export const RENDER_DURATION_FRAMES = Number(process.env.RENDER_DURATION_FRAMES ?? 150);
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 8 * 60 * 1000);

const TEMPLATE_PACKAGE = {
  name: "render-template",
  private: true,
  type: "module",
  dependencies: {
    react: "^18.3.1",
    "react-dom": "^18.3.1",
    remotion: "^4.0.0",
    "@remotion/cli": "^4.0.0",
  },
};

const INDEX_TS = `import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";
registerRoot(RemotionRoot);
`;

const ROOT_TSX = `import { Composition } from "remotion";
import { Video, calcMeta } from "./Video";

export const RemotionRoot = () => (
  <Composition
    id="Video"
    component={Video}
    durationInFrames={${RENDER_DURATION_FRAMES}}
    fps={${RENDER_FPS}}
    width={${RENDER_WIDTH}}
    height={${RENDER_HEIGHT}}
    calculateMetadata={calcMeta}
  />
);
`;

// Relie n'importe quel composant exporté par l'agent à l'export "Video" attendu,
// et propage calculateMetadata (durée dérivée du contenu, ex. somme des durées audio).
const VIDEO_TSX = `import * as Agent from "./Agent";
const mod = Agent as unknown as Record<string, unknown>;
const C = (mod.Video ?? mod.RemotionVideo ?? mod.MyComp ?? mod.default ?? Object.values(mod)[0]) as React.ComponentType;
export const Video: React.FC = () => <C />;
export const calcMeta = (mod.calculateMetadata ?? undefined) as any;
`;

let templateReady = false;

function ensureTemplate(): void {
  if (templateReady && existsSync(join(TEMPLATE_DIR, "node_modules"))) return;
  mkdirSync(join(TEMPLATE_DIR, "src"), { recursive: true });
  writeFileSync(join(TEMPLATE_DIR, "package.json"), JSON.stringify(TEMPLATE_PACKAGE, null, 2));
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: TEMPLATE_DIR, stdio: "inherit" });
  // Télécharge Chrome Headless Shell (nécessite les libs système : libnss3, libnspr4, libatk, etc.)
  execFileSync("npx", ["remotion", "browser", "ensure"], { cwd: TEMPLATE_DIR, stdio: "inherit" });
  templateReady = true;
}

/** Extrait le plus grand bloc de code tsx/tsx/js de la sortie du Monteur. */
export function extractRemotionCode(output: string): string | null {
  const blocks = [...output.matchAll(/```(?:tsx|jsx|ts|typescript)?\s*\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((b) => b.includes("export"));
  if (!blocks.length) return null;
  return blocks.sort((a, b) => b.length - a.length)[0];
}

/**
 * Rend la vidéo MP4 à partir du code Remotion produit par le Monteur.
 * Retourne le chemin du MP4 généré (dans data/artifacts via l'appelant).
 */
export function renderVideoToFile(workDir: string, agentCode: string, outFile: string): void {
  ensureTemplate();
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "src"), { recursive: true });
  cpSync(join(TEMPLATE_DIR, "package.json"), join(workDir, "package.json"));
  // node_modules du template partagé via symlink (évite de copier des centaines de Mo par rendu)
  symlinkSync(join(TEMPLATE_DIR, "node_modules"), join(workDir, "node_modules"), "dir");
  writeFileSync(join(workDir, "src", "index.ts"), INDEX_TS);
  writeFileSync(join(workDir, "src", "Root.tsx"), ROOT_TSX);
  writeFileSync(join(workDir, "src", "Video.tsx"), VIDEO_TSX);
  writeFileSync(join(workDir, "src", "Agent.tsx"), agentCode);
  execFileSync(
    "npx",
    ["remotion", "render", "src/index.ts", "Video", outFile, "--codec", "h264"],
    { cwd: workDir, stdio: "pipe", timeout: RENDER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
  );
}
