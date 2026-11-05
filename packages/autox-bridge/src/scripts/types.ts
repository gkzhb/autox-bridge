import type { z } from 'zod';
import type { scriptManifestSchema, scriptParameterSchema, scriptValueSchema } from './manifest.js';

export type ScriptValue = z.infer<typeof scriptValueSchema>;
export type ScriptParameter = z.infer<typeof scriptParameterSchema>;
export type ScriptManifest = z.infer<typeof scriptManifestSchema>;
export interface RegisteredScript {
  directory: string;
  manifestPath: string;
  entryPath: string;
  id: string;
  manifest: ScriptManifest;
}
export interface ScriptDiagnostic { directory: string; error: string; name?: string }
export interface ScriptRegistry {
  root: string;
  scripts: RegisteredScript[];
  diagnostics: ScriptDiagnostic[];
}
