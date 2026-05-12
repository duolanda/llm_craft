import { LocalPreset } from "@llmcraft/shared";

const STORAGE_KEY = "llmcraft_presets";

export type { LocalPreset };

export function loadPresets(): LocalPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as LocalPreset[];
  } catch {
    return [];
  }
}

export function savePreset(preset: LocalPreset): void {
  const presets = loadPresets();
  const idx = presets.findIndex((p) => p.id === preset.id);
  if (idx >= 0) {
    presets[idx] = { ...preset, updatedAt: new Date().toISOString() };
  } else {
    presets.push({
      ...preset,
      id: preset.id || crypto.randomUUID(),
      createdAt: preset.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

export function deletePreset(id: string): void {
  const presets = loadPresets().filter((p) => p.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

export function exportPresets(): string {
  return JSON.stringify(loadPresets(), null, 2);
}

export function importPresets(json: string): { imported: number; skipped: number } {
  const incoming = JSON.parse(json) as LocalPreset[];
  if (!Array.isArray(incoming)) throw new Error("无效的预设文件格式");

  const existing = loadPresets();
  const existingIds = new Set(existing.map((p) => p.id));
  let imported = 0;
  let skipped = 0;

  for (const preset of incoming) {
    if (existingIds.has(preset.id)) {
      const idx = existing.findIndex((p) => p.id === preset.id);
      existing[idx] = { ...preset, updatedAt: new Date().toISOString() };
      imported++;
    } else {
      existing.push({
        ...preset,
        id: preset.id || crypto.randomUUID(),
        createdAt: preset.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      imported++;
    }
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
  return { imported, skipped };
}
