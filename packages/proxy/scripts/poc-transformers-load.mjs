// PoC Fase 7 - Paso 1: verificar que @huggingface/transformers carga sin errores.
// No descarga modelos, no ejecuta inferencias. Solo importa la librería y reporta su versión.
import { pipeline, env } from '@huggingface/transformers';

console.log('[poc] @huggingface/transformers cargada correctamente');
console.log('[poc] env.version:', env.version ?? '(no expuesto)');
console.log('[poc] env.backends disponibles:', Object.keys(env.backends ?? {}));
console.log('[poc] typeof pipeline:', typeof pipeline);
