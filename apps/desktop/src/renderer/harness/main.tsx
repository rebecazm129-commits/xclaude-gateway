// Renderer harness entry. Runs in a plain browser tab under `vite`, never
// inside Electron: there is no main process, so there is no path to the
// filesystem, the Keychain, the login items or the audit trail. The renderer
// only ever reached those through window.xcg → IPC → main; with no main, the
// capability does not exist rather than merely going unused.

import '../index.css';
import './harness.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '../App.js';
import { buildFakeApi } from './fake-api.js';
import { SCENARIOS, scenarioById } from './fixtures.js';

const params = new URLSearchParams(window.location.search);
const scenario = scenarioById(params.get('scenario'));

// Install the fake BEFORE React mounts: App reads window.xcg on its first
// effect pass.
window.xcg = buildFakeApi(scenario);

// Land on the tab the scenario is about, through the same key the app reads —
// no test-only prop on App, and the tab persistence stays exercised.
try {
  if (scenario.tab !== undefined) window.localStorage.setItem('xcg:lastTab', scenario.tab);
} catch {
  // Private mode: the app falls back to its own default, which is fine here.
}

function Bar(): JSX.Element {
  return (
    <div className="harnessBar">
      <span className="harnessTag">HARNESS</span>
      <select
        className="harnessPick"
        value={scenario.id}
        onChange={(e) => {
          window.location.search = `?scenario=${e.target.value}`;
        }}
      >
        {SCENARIOS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      <span className="harnessNote">{scenario.note}</span>
    </div>
  );
}

const rootElement = document.getElementById('harness-root');
if (rootElement === null) throw new Error('#harness-root not found');

createRoot(rootElement).render(
  <StrictMode>
    <Bar />
    <div className="harnessFrame">
      <App />
    </div>
  </StrictMode>,
);
