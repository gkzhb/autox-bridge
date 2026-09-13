import { validateInput } from './manifest.js';
import { MAX_SCRIPT_BYTES, readScriptFile } from './registry.js';
import type { RegisteredScript } from './types.js';

export const MAX_INPUT_BYTES = 64 * 1024;
const marker = '__AUTOX_INPUT__';

export function parseScriptInput(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new Error(`Input exceeds ${MAX_INPUT_BYTES} bytes`);
  try { return JSON.parse(text); }
  catch { throw new Error('Input must be valid JSON'); }
}

/** Recognize only a documented prologue, leaving arbitrary AutoX syntax in the body untouched. */
function inputOffset(source: string, parameterized: boolean): number | undefined {
  const count = source.split(marker).length - 1;
  if (!count && !parameterized) return undefined;
  if (count !== 1) throw new Error(`Expected exactly one ${marker} placeholder in the input declaration`);
  let offset = 0;
  while (offset < source.length) {
    const rest = source.slice(offset);
    const trivia = /^(?:\s+|\/\/[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$)|\/\*[\s\S]*?\*\/)/.exec(rest);
    if (trivia) { offset += trivia[0].length; continue; }
    const directive = /^(?:"(?:ui|use strict)"|'(?:ui|use strict)')[\t ]*;/.exec(rest);
    if (directive) { offset += directive[0].length; continue; }
    const declaration = /^var[\t ]+input[\t ]*=[\t ]*__AUTOX_INPUT__[\t ]*;/.exec(rest);
    if (declaration) return offset + declaration[0].indexOf(marker);
    break;
  }
  throw new Error(`Place var input = ${marker}; in the prologue, after optional comments and ui/use strict directives`);
}

export function validateScriptTemplate(script: RegisteredScript, source: string): void {
  inputOffset(source, Object.keys(script.manifest.parameters ?? {}).length > 0);
}

export async function compileScript(root: string, script: RegisteredScript, input: unknown = {}): Promise<{ id: string; name: string; script: string }> {
  // Input is untrusted even when called outside the CLI parser.
  const values = validateInput(script.manifest, input);
  const json = JSON.stringify(values);
  if (Buffer.byteLength(json) > MAX_INPUT_BYTES) throw new Error(`Input exceeds ${MAX_INPUT_BYTES} bytes`);
  const source = await readScriptFile(root, script.entryPath, MAX_SCRIPT_BYTES);
  const offset = inputOffset(source, Object.keys(script.manifest.parameters ?? {}).length > 0);
  // Encode JSON as a string consumed on-device, never as executable user input.
  const literal = JSON.stringify(json).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const compiled = offset === undefined ? source : source.slice(0, offset) + `JSON.parse(${literal})` + source.slice(offset + marker.length);
  return { id: script.id, name: `${script.manifest.name}.js`, script: compiled };
}
