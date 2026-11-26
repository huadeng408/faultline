import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
const extDir = path.join(rootDir, 'dist-extension');

if (!fs.existsSync(distDir)) {
  console.log('[mv3] Building production web bundle first...');
  execSync('npm run build', { stdio: 'inherit' });
}

fs.rmSync(extDir, { recursive: true, force: true });
fs.cpSync(distDir, extDir, { recursive: true });

// Remove web service worker inside MV3 package to avoid collision with extension background worker
const webSw = path.join(extDir, 'sw.js');
if (fs.existsSync(webSw)) fs.rmSync(webSw);

const mv3Manifest = {
  manifest_version: 3,
  name: 'FaultLine v3 · Hybrid AI Side-Panel Stress Workbench',
  version: '3.6.0',
  description:
    'Right-click any operational plan, runbook, or spec table to stress-test failure margins locally with Gemini Nano 4 + Buckingham-Pi Airlock.',
  permissions: ['sidePanel', 'contextMenus', 'storage'],
  background: {
    service_worker: 'service-worker.js',
    type: 'module',
  },
  side_panel: {
    default_path: 'index.html',
  },
  action: {
    default_title: 'Open FaultLine v3 CAD Workbench',
  },
};

const mv3Worker = `chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.create({
    id: 'faultline-stress-test-selection',
    title: 'Stress-Test Selection in FaultLine v3',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'faultline-stress-test-selection' && info.selectionText) {
    chrome.storage.local.set({
      faultline_selection_text: info.selectionText,
      faultline_selection_ts: Date.now(),
    });
    if (tab && tab.windowId) {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    }
  }
});
`;

fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(mv3Manifest, null, 2), 'utf8');
fs.writeFileSync(path.join(extDir, 'service-worker.js'), mv3Worker, 'utf8');
console.log('[mv3] Chrome MV3 Side-Panel extension written cleanly to dist-extension/');
