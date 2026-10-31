import * as THREE from "three";

/** Per-instance alpha hashing keeps depth and batching without sorting translucent hulls. */
export function writeInstanceFade(mesh: THREE.InstancedMesh, index: number, opacity: number, hashed = true): void {
  let attribute = mesh.geometry.getAttribute("questFade") as THREE.InstancedBufferAttribute | undefined;
  if (!attribute) {
    // Only the small fade buffer is new; vertex and index buffers remain shared.
    const source = mesh.geometry, geometry = new THREE.BufferGeometry();
    for (const [name, buffer] of Object.entries(source.attributes)) geometry.setAttribute(name, buffer);
    geometry.setIndex(source.index);
    geometry.groups = source.groups.map(group => ({ ...group }));
    geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
    geometry.boundingBox = source.boundingBox; geometry.boundingSphere = source.boundingSphere;
    attribute = new THREE.InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("questFade", attribute); mesh.geometry = geometry;
    const material = (mesh.material as THREE.Material).clone();
    material.alphaHash = hashed;
    if (!hashed) material.transparent = true;
    material.onBeforeCompile = shader => {
      shader.vertexShader = "attribute float questFade; varying float vQuestFade;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvQuestFade = questFade;");
      shader.fragmentShader = "varying float vQuestFade;\n" + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.a *= vQuestFade;");
    };
    material.customProgramCacheKey = () => `quest-instance-fade-v1-${hashed ? "hash" : "blend"}`;
    mesh.material = material;
  }
  attribute.setX(index, opacity); attribute.needsUpdate = true;
}
