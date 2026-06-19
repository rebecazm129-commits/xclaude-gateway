import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';

// macOS 26 (Tahoe): right-click builds a native AppKit context menu in the
// browser process, which crashes (EXC_BAD_ACCESS in CrBrowserMain). Suppress
// the menu at its source — the DOM contextmenu event — so Chromium never asks
// the browser process to construct the native menu. preventDefault on the DOM
// event is the reliable Chromium path; the main-process 'context-menu' event
// is only a build-your-own hook and does not reliably cancel the native menu.
// Keyboard cut/copy/paste/select-all still work via the default app menu roles.
window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
