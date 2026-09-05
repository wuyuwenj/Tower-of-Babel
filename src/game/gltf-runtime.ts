import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";

/**
 * The one GLTFLoader every Mint-generated GLB goes through.
 *
 * Mint's optimizer emits `KHR_draco_mesh_compression`, and convex/mint.ts
 * prefers that optimized URL — so a bare GLTFLoader throws "No DRACOLoader
 * instance provided" the first time a forge returns one. That failure is
 * invisible until it happens live: it drops the creature back to stock shapes
 * and, worse, drops the world collider.
 *
 * The decoder is served from public/draco rather than Mint's CDN. Mint
 * documents https://cdn.mint.gg/runtime/draco/gltf/three-0.184.0/, but the
 * seed splats are already cached locally for exactly this reason — venue wifi
 * is not something a two-minute demo should depend on — and these files are
 * version-matched to the three we actually build against.
 *
 * Decoding runs in a worker pool that is created once and shared. Building a
 * DRACOLoader per model would spawn a new pool per creature.
 */
const DECODER_PATH = "/draco/";

let draco: DRACOLoader | null = null;

function decoder(): DRACOLoader {
  if (!draco) {
    draco = new DRACOLoader();
    draco.setDecoderPath(DECODER_PATH);
    // Left at the default: wasm when the browser allows it, the JS build
    // otherwise. Both are vendored alongside the wrapper.
    draco.preload();
  }
  return draco;
}

/**
 * A GLTFLoader wired for Mint output. Cheap to call — the expensive part, the
 * decoder and its workers, is shared across every loader handed out.
 */
export function createGltfLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setDRACOLoader(decoder());
  return loader;
}

/**
 * Extensions a file needs that this runtime cannot supply. Draco is handled;
 * meshopt and KTX2 would each need their own decoder wired in, and silently
 * loading such a file yields a broken mesh rather than an error.
 */
const SUPPORTED_REQUIRED = new Set(["KHR_draco_mesh_compression"]);

export function unsupportedExtensions(required: string[] | undefined): string[] {
  return (required ?? []).filter((name) => !SUPPORTED_REQUIRED.has(name));
}

/** Release the shared decoder's workers. Only for permanent teardown. */
export function disposeGltfRuntime(): void {
  draco?.dispose();
  draco = null;
}
