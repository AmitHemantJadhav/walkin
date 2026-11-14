Google Gen AI JavaScript SDK @google/genai 2.32.0 (Apache-2.0, LICENSE), web build bundled with its one
runtime import (p-retry, MIT) into a single ES module with esbuild 0.24.0:
  export { GoogleGenAI, Modality, Type, Behavior } from "@google/genai"
Used by live.js for the Gemini Live API (two-way voice). Vendored so the demo does not depend on venue Wi-Fi.
