// Browser entry of the Three.js renderer (bundled by ../index.ts with esbuild and injected into a headless Chrome page).
import { createShot } from "./shot";
(window as unknown as { studio3d: unknown }).studio3d = { createShot };
