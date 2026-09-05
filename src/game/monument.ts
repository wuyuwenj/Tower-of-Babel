import * as THREE from "three";
import { loadGltf } from "./models";

/**
 * The statue of whoever cleared the previous level first, standing near spawn
 * with their plaque. It is the only permanent trace a player leaves in the tower.
 */
export async function buildMonument(
  url: string | null,
  forgedBy: string | null,
  coForgers: string[],
  color: number,
): Promise<THREE.Group> {
  const group = new THREE.Group();

  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(1.15, 1.35, 0.7, 16),
    new THREE.MeshStandardMaterial({ color: 0x2b2a2e, roughness: 0.9 }),
  );
  plinth.position.y = 0.35;
  group.add(plinth);

  const glow = new THREE.Mesh(
    new THREE.RingGeometry(1.4, 1.9, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.03;
  group.add(glow);

  let statue: THREE.Object3D;
  if (url) {
    try {
      const scene = await loadGltf(url);
      normalize(scene, 3.2);
      statue = scene;
    } catch {
      statue = placeholder(color);
    }
  } else {
    statue = placeholder(color);
  }
  statue.position.y = 0.7;
  group.add(statue);

  if (forgedBy) {
    const plaque = makePlaque(forgedBy, coForgers);
    plaque.position.set(0, 1.05, 1.5);
    group.add(plaque);
  }

  return group;
}

function placeholder(color: number): THREE.Object3D {
  const mesh = new THREE.Mesh(
    new THREE.OctahedronGeometry(1.1, 0),
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.35,
      metalness: 0.4,
      emissive: color,
      emissiveIntensity: 0.22,
    }),
  );
  mesh.position.y = 1.4;
  return mesh;
}

function normalize(object: THREE.Object3D, targetHeight: number): void {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const scale = targetHeight / Math.max(size.y, 0.0001);
  object.scale.setScalar(scale);
  object.position.set(
    -((box.min.x + box.max.x) / 2) * scale,
    -box.min.y * scale,
    -((box.min.z + box.max.z) / 2) * scale,
  );
}

function makePlaque(forgedBy: string, coForgers: string[]): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 192;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "rgba(10, 11, 16, 0.88)";
  roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 16);
  ctx.fill();
  ctx.strokeStyle = "rgba(232, 198, 122, 0.55)";
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.fillStyle = "#8d8a83";
  ctx.font = "26px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("FORGED BY", canvas.width / 2, 58);

  ctx.fillStyle = "#e8c67a";
  ctx.font = "600 52px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(forgedBy, canvas.width / 2, 114);

  if (coForgers.length > 0) {
    ctx.fillStyle = "#8d8a83";
    ctx.font = "24px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(`with ${coForgers.slice(0, 4).join(", ")}`, canvas.width / 2, 154);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(4, 1, 1);
  return sprite;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
