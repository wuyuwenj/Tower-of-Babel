import * as THREE from "three";

/**
 * The message the floor's architect left, written across the ground at spawn.
 *
 * It lies flat on the floor rather than standing up, so it reads as part of the
 * world and never blocks the fight: everyone who climbs this far walks over it.
 */
export function buildInscription(message: string, forgedBy: string | null, color: number): THREE.Group {
  const group = new THREE.Group();

  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;

  const text = message.slice(0, 80);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // A soft dark bed so light words stay legible on a bright floor.
  const bed = ctx.createRadialGradient(512, 128, 40, 512, 128, 480);
  bed.addColorStop(0, "rgba(6, 7, 11, 0.62)");
  bed.addColorStop(1, "rgba(6, 7, 11, 0)");
  ctx.fillStyle = bed;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const size = text.length > 46 ? 60 : text.length > 28 ? 74 : 88;
  ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
  ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
  ctx.shadowBlur = 18;
  ctx.fillStyle = "#f0dca8";
  ctx.fillText(text, 512, forgedBy ? 108 : 128);

  if (forgedBy) {
    ctx.font = "400 40px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "rgba(232, 198, 122, 0.72)";
    ctx.fillText(`— ${forgedBy}`, 512, 178);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 4),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      // Splat worlds have noisy geometry near the ground; bias the decal up out
      // of it rather than letting it z-fight with whatever it lands on.
      polygonOffset: true,
      polygonOffsetFactor: -4,
    }),
  );
  plane.rotation.x = -Math.PI / 2;
  group.add(plane);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(8.4, 8.9, 64),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  return group;
}
