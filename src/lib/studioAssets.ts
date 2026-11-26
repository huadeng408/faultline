import * as THREE from 'three';
import { EXRLoader } from 'three-stdlib';
import { zipSync, strToU8 } from 'fflate';
import normalIce from '@pmndrs/assets/normals/0003.webp.js';
import normalMetal from '@pmndrs/assets/normals/0007.webp.js';
import interBoldWoff from '@pmndrs/assets/fonts/inter_bold.woff.js';

export function dataUriToArrayBuffer(dataUri: string): ArrayBuffer {
  const commaIdx = dataUri.indexOf(',');
  const b64 = commaIdx >= 0 ? dataUri.slice(commaIdx + 1) : dataUri;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Tree-shakable synchronous 32-bit CC0 EXR HDRI loader: pass a single imported EXR data URI
 * (e.g. `import studioExr from '@pmndrs/assets/hdri/studio.exr.js'`) so Vite only bundles that 1 HDRI.
 */
export function applyExrEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  exrDataUri: string,
  intensity = 1.15
): THREE.Texture | null {
  try {
    const rawBuffer = dataUriToArrayBuffer(exrDataUri);
    const loader = new EXRLoader();
    const parsed = loader.parse(rawBuffer);
    const exrTex = new THREE.DataTexture(
      parsed.data as unknown as THREE.TypedArray,
      parsed.width,
      parsed.height,
      parsed.format,
      parsed.type
    );
    exrTex.mapping = THREE.EquirectangularReflectionMapping;
    exrTex.needsUpdate = true;

    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const envRT = pmrem.fromEquirectangular(exrTex);
    scene.environment = envRT.texture;
    if ('environmentIntensity' in scene) {
      (scene as THREE.Scene & { environmentIntensity: number }).environmentIntensity = intensity;
    }
    exrTex.dispose();
    pmrem.dispose();
    return envRT.texture;
  } catch {
    return null;
  }
}

export function loadStudioNormalMap(kind: 'ice' | 'metal' = 'ice', repeat = 3): THREE.Texture {
  const tex = new THREE.TextureLoader().load(kind === 'ice' ? normalIce : normalMetal);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  return tex;
}

let fontsInjected = false;
export function injectStudioFonts(): void {
  if (fontsInjected || typeof document === 'undefined') return;
  fontsInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-faultline-studio-fonts', '1');
  style.textContent = `
    @font-face {
      font-family: 'FaultLine Studio Display';
      src: url('${interBoldWoff}') format('woff');
      font-weight: 700 900;
      font-style: normal;
      font-display: block;
    }
  `;
  document.head.appendChild(style);
}

export function downloadBundleZip(zipFilename: string, files: Record<string, string>): void {
  const payload: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    payload[name] = strToU8(content);
  }
  const zipped = zipSync(payload, { level: 6 });
  const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = zipFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
