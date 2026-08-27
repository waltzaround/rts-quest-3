import type { PhysicsRuntime } from "./index";

const runtimePromises = new WeakMap<WebAssembly.Module, Promise<PhysicsRuntime>>();

/** Uses a Cloudflare precompiled module, avoiding forbidden runtime WASM compilation. */
export async function loadPhysicsRuntimeFromModule(
  compiledModule: WebAssembly.Module,
): Promise<PhysicsRuntime> {
  const existingPromise = runtimePromises.get(compiledModule);
  if (existingPromise !== undefined) {
    return existingPromise;
  }
  const runtimePromise = instantiatePhysicsRuntimeFromModule(compiledModule);
  runtimePromises.set(compiledModule, runtimePromise);
  try {
    return await runtimePromise;
  } catch (error) {
    runtimePromises.delete(compiledModule);
    throw error;
  }
}

async function instantiatePhysicsRuntimeFromModule(
  compiledModule: WebAssembly.Module,
): Promise<PhysicsRuntime> {
  const { default: createBox3D } = await import("box3d.js");
  // Workerd exposes a partial process shim; hiding it prevents Emscripten from
  // selecting its Node loader before the precompiled-module hook runs.
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const processShim = globalRecord["process"];
  globalRecord["process"] = undefined;
  try {
    const module = await createBox3D({
      instantiateWasm(
        imports: WebAssembly.Imports,
        receiveInstance: (instance: WebAssembly.Instance) => void,
      ): WebAssembly.Exports {
        const instance = new WebAssembly.Instance(compiledModule, imports);
        receiveInstance(instance);
        return instance.exports;
      },
    });
    return { backend: "box3d-wasm", module };
  } finally {
    globalRecord["process"] = processShim;
  }
}
