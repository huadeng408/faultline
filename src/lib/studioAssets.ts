import { zipSync, strToU8 } from 'fflate';
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
      font-display: swap;
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
