import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const knownBlenderPaths = [
  process.env.BLENDER_PATH,
  "D:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe",
  "D:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe",
  "C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe",
  "C:\\Program Files\\Blender Foundation\\Blender 4.4\\blender.exe",
  "C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe",
].filter(Boolean);

function findBlenderOnPath() {
  const result = spawnSync("where.exe", ["blender"], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && existsSync(line)) ?? null;
}

const blenderPath = knownBlenderPaths.find((candidate) => existsSync(candidate)) ?? findBlenderOnPath();

if (!blenderPath) {
  console.error("Blender executable not found. Set BLENDER_PATH or install Blender 5.x.");
  process.exit(1);
}

const textureScriptPath = path.join(__dirname, "generate-battlefield-textures.py");
const textureResult = spawnSync("python", [textureScriptPath], {
  cwd: path.resolve(__dirname, ".."),
  stdio: "inherit",
});

if (textureResult.status !== 0) {
  console.error("Battlefield texture generation failed. Python and Pillow are required.");
  process.exit(textureResult.status ?? 1);
}

const scriptPath = path.join(__dirname, "generate-battlefield-models.py");
const result = spawnSync(blenderPath, ["--background", "--python-exit-code", "1", "--python", scriptPath], {
  cwd: path.resolve(__dirname, ".."),
  stdio: "inherit",
});

process.exit(result.status ?? 1);
