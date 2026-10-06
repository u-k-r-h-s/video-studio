import * as THREE from "three";

/**
 * A cheap "volumetric" light shaft: an open cone with a shader that fades along its length and toward its silhouette edges,
 * drawn additively. Reads as light in the air (fog/rain) without a real volumetric pass, which the M1 cannot afford at 1080x1920.
 * The cone's apex is at the origin and it points along +Y; parent it to a light and orient it.
 */
export function lightShaft(color: string, length: number, radius: number, intensity = 0.35): THREE.Mesh & { setIntensity(v: number): void } {
  const geo = new THREE.ConeGeometry(radius, length, 48, 1, true);
  geo.translate(0, -length / 2, 0); // apex at the origin, opening toward -Y
  geo.rotateX(Math.PI); // ... now opening toward +Y
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(color) }, uIntensity: { value: intensity }, uLength: { value: length } },
    vertexShader: `
      varying float vAlong; varying vec3 vN; varying vec3 vView;
      uniform float uLength;
      void main() {
        vAlong = position.y / uLength;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vAlong; varying vec3 vN; varying vec3 vView;
      uniform vec3 uColor; uniform float uIntensity;
      void main() {
        float edge = pow(abs(dot(normalize(vN), normalize(vView))), 1.6); // soft silhouette
        float fall = pow(1.0 - clamp(vAlong, 0.0, 1.0), 1.8) * smoothstep(0.0, 0.06, vAlong);
        gl_FragColor = vec4(uColor * uIntensity * edge * fall, 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat) as unknown as THREE.Mesh & { setIntensity(v: number): void };
  m.setIntensity = (v: number): void => { mat.uniforms.uIntensity!.value = v; m.visible = v > 0.002; };
  m.renderOrder = 10;
  return m;
}

/** A soft glow sprite (bulb halo, lens flare) that always faces the camera. */
export function glowSprite(color: string, size: number): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, map: radialTexture() });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(size);
  return s;
}

let radial: THREE.DataTexture | null = null;
function radialTexture(): THREE.DataTexture {
  if (radial) return radial;
  const n = 64, d = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const r = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2);
    const a = Math.max(0, 1 - r) ** 2.2;
    d.set([255, 255, 255, Math.round(a * 255)], (y * n + x) * 4);
  }
  radial = new THREE.DataTexture(d, n, n);
  radial.needsUpdate = true;
  return radial;
}
