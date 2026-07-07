import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

import type { SeedClientResult } from '../../shared/types.js';

import styles from './ConnectorSetupWizard.module.css';

// External deep link opened in the system browser (never navigates the renderer).
function LinkBtn({ url, children }: { url: string; children: ReactNode }): ReactElement {
  return (
    <button
      type="button"
      className={styles['linkBtn']}
      onClick={() => void window.xcg.openExternalUrl(url)}
    >
      {children} ↗
    </button>
  );
}

export interface SetupWizardStep {
  /** Short name used in the intro's "N steps: a → b → …" line. */
  readonly shortName: string;
  /** Step heading, shown under the "Step i/N" counter. */
  readonly title: string;
  /** Advance button label: "Done — next" for do-then-continue steps, plain
   *  "Next" for steps whose action completes out of band (e.g. enrollment). */
  readonly advanceLabel: string;
  readonly body: ReactNode;
}

export interface SetupWizardCredentials {
  readonly shortName: string;
  readonly title: string;
  /** Connectors seeded together with the one pasted client. */
  readonly targets: readonly string[];
  /** Whether the provider's token endpoint needs a client secret (Google: yes;
   *  public-PKCE clients like Slack: no). Required + empty after trim is a UI
   *  validation error — config:seed-client is never called without it. When
   *  false the secret field is not rendered at all. */
  readonly secretRequired: boolean;
  /** Shown when secretRequired and the field is empty; unused otherwise. */
  readonly secretRequiredError?: string;
  /** Muted helper under the Client ID field (e.g. where to find it). */
  readonly idHint?: string;
  readonly successMessage: string;
}

/** One connector family's setup flow. The wizard derives everything (step
 *  count, labels, seeding targets) from this, so a future variant (Slack:
 *  client_id only, no secret) is a second catalog — not a second wizard. */
export interface SetupCatalog {
  readonly title: string;
  /** Intro copy, one <p> per entry (mockup: paragraphs, not bullets). */
  readonly introParagraphs: readonly string[];
  readonly warning: string;
  readonly startLabel: string;
  readonly steps: readonly SetupWizardStep[];
  /** Always the final, numbered step (total = steps.length + 1). */
  readonly credentials: SetupWizardCredentials;
}

const CREATE_PROJECT_URL = 'https://console.cloud.google.com/projectcreate';
// All six services the three connectors need — each product requires its base
// API and its MCP API (developers.google.com/workspace/guides/configure-mcp-servers).
// Note Calendar's base API id is calendar-json, not calendar.
const ENABLE_APIS_URL =
  'https://console.cloud.google.com/flows/enableapi?apiid=' +
  'gmail.googleapis.com,drive.googleapis.com,calendar-json.googleapis.com,' +
  'gmailmcp.googleapis.com,drivemcp.googleapis.com,calendarmcp.googleapis.com';
const CONSENT_SCREEN_URL = 'https://console.cloud.google.com/auth/branding';
const CLIENTS_URL = 'https://console.cloud.google.com/auth/clients';
// The program page (stable), not the enrollment Google Form (opaque, rotatable URL).
const ENROLLMENT_URL = 'https://developers.google.com/workspace/preview';

const GOOGLE_CATALOG: SetupCatalog = {
  title: 'Set up Google connectors',
  introParagraphs: [
    "You'll create your own free Google OAuth client — one client serves Gmail, Calendar " +
      'and Drive, and it stays in your macOS Keychain.',
    'No Google Cloud experience needed. One time, about 10 minutes.',
  ],
  warning:
    "You'll need an email on a custom domain for one step. Google's Preview enrollment " +
    'form rejects plain Gmail addresses — but the Google account you connect can be a ' +
    'regular Gmail.',
  startLabel: 'Start setup',
  steps: [
    {
      shortName: 'Cloud project',
      title: 'Cloud project + APIs',
      advanceLabel: 'Done — next',
      body: (
        <>
          <div className={styles['block']}>
            <span className={styles['blockTitle']}>Cloud project</span>
            <p className={styles['text']}>
              Create a Google Cloud project — or pick one you already have.
            </p>
            <LinkBtn url={CREATE_PROJECT_URL}>Create a Cloud project</LinkBtn>
          </div>
          <div className={styles['block']}>
            <span className={styles['blockTitle']}>Required APIs</span>
            <p className={styles['text']}>
              Enable the required APIs — one click enables all six (each of Gmail, Calendar
              and Drive needs its base API and its MCP API).
            </p>
            <LinkBtn url={ENABLE_APIS_URL}>Enable all required APIs</LinkBtn>
          </div>
        </>
      ),
    },
    {
      shortName: 'OAuth client',
      title: 'OAuth client',
      advanceLabel: 'Done — next',
      body: (
        <>
          <div className={styles['block']}>
            <span className={styles['blockTitle']}>Consent screen</span>
            <p className={styles['text']}>
              Choose <b>Internal</b> if available, otherwise <b>External</b> — and add your
              own email under <b>Test users</b>.
            </p>
            <LinkBtn url={CONSENT_SCREEN_URL}>Open the consent screen</LinkBtn>
          </div>
          <div className={styles['block']}>
            <span className={styles['blockTitle']}>OAuth client</span>
            <p className={styles['text']}>
              Create a client with application type <b>Desktop app</b>. Google issues a
              Client ID and a Client secret — copy both now; you can retrieve them anytime
              from the Clients page.
            </p>
            <LinkBtn url={CLIENTS_URL}>Open the Clients page</LinkBtn>
          </div>
        </>
      ),
    },
    {
      shortName: 'Preview enrollment',
      title: 'Preview enrollment',
      advanceLabel: 'Next',
      body: (
        <>
          <div className={styles['block']}>
            <span className={styles['blockTitle']}>Enrollment</span>
            <p className={styles['text']}>
              Enroll your Cloud project in the Google Workspace Developer Preview Program.
              Approval arrives by email, usually within a couple of days.
            </p>
            <p className={styles['warn']}>
              The enrollment form requires an email on a custom domain — plain Gmail
              addresses are rejected.
            </p>
            <p className={styles['text']}>Have your project number ready — the form asks for it.</p>
            <LinkBtn url={ENROLLMENT_URL}>Open the enrollment page</LinkBtn>
          </div>
          <p className={styles['muted']}>
            You can continue to the last step now and connect once the approval email
            arrives.
          </p>
        </>
      ),
    },
  ],
  credentials: {
    shortName: 'paste your credentials',
    title: 'Paste your credentials',
    targets: ['gmail', 'calendar', 'drive'],
    secretRequired: true,
    secretRequiredError: 'Google requires a client secret.',
    successMessage: 'Saved to Keychain — Gmail, Calendar and Drive are ready to connect.',
  },
};

// The user's own Slack app, created in one click from a preloaded manifest.
// Mirror of Rebeca's production app config. Keep redirect_urls in sync with
// KeychainOAuthProvider.REDIRECT_URI (packages/proxy/src/oauth-provider.ts).
const SLACK_APP_MANIFEST = {
  display_information: {
    name: 'xCLAUDE Slack Connector',
    description: 'Connects Slack to xCLAUDE Gateway — every call recorded and classified.',
  },
  features: {
    bot_user: { display_name: 'xCLAUDE Slack Connector', always_online: false },
  },
  oauth_config: {
    redirect_urls: ['http://127.0.0.1:51703/xcg-callback'],
    scopes: {
      user: [
        'search:read.public', 'search:read.private', 'search:read.mpim', 'search:read.im',
        'search:read.files', 'search:read.users', 'channels:history', 'groups:history',
        'mpim:history', 'im:history', 'channels:read', 'groups:read', 'mpim:read',
        'files:read', 'emoji:read', 'reactions:read', 'canvases:read', 'users:read',
        'users:read.email', 'chat:write', 'canvases:write', 'reactions:write',
        'channels:write', 'groups:write', 'im:write', 'mpim:write',
      ],
      bot: ['users:read'],
    },
    // Slack DROPS this flag when the app is created via the manifest URL, and
    // it is no longer needed: PKCE went GA (March 2026) without a per-app
    // opt-in — the full OAuth flow worked without it in the 2026-07-06 dogfood.
    // Kept for fidelity to the original app manifest; harmless if ignored.
    pkce_enabled: true,
  },
  settings: {
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
    is_mcp_enabled: true,
  },
};

// Slack's app-creation flow accepts a URL-encoded manifest in either format
// (docs.slack.dev/app-manifests: manifest_yaml and manifest_json); we hold
// JSON, so encode it as manifest_json.
const CREATE_SLACK_APP_URL =
  'https://api.slack.com/apps?new_app=1&manifest_json=' +
  encodeURIComponent(JSON.stringify(SLACK_APP_MANIFEST));

const SLACK_CATALOG: SetupCatalog = {
  title: 'Set up Slack',
  introParagraphs: [
    "You'll create your own Slack app — it stays in your workspace, and its client ID " +
      'stays in your macOS Keychain.',
    'One time, about 2 minutes — most of it is one click.',
    "Slack asks you to re-authorize about once a month — that's how Slack designed it, " +
      'not an error.',
  ],
  warning: 'Your workspace admin may need to approve the app before you can connect.',
  startLabel: 'Start setup',
  steps: [
    {
      shortName: 'Slack app',
      title: 'Create the Slack app',
      advanceLabel: 'Done — next',
      body: (
        <div className={styles['block']}>
          <span className={styles['blockTitle']}>Slack app</span>
          <p className={styles['text']}>
            One click opens Slack with the app pre-configured — scopes, PKCE and MCP
            included. Pick your workspace and hit Create.
          </p>
          <LinkBtn url={CREATE_SLACK_APP_URL}>Create the Slack app</LinkBtn>
        </div>
      ),
    },
  ],
  credentials: {
    shortName: 'paste your Client ID',
    title: 'Paste your Client ID',
    targets: ['slack'],
    secretRequired: false,
    successMessage: 'Saved to Keychain — Slack is ready to connect.',
    idHint: 'Basic Information → App Credentials → Client ID (looks like 1234567890.1234567890)',
  },
};

export const SETUP_CATALOGS = { google: GOOGLE_CATALOG, slack: SLACK_CATALOG } as const;

export interface ConnectorSetupWizardProps {
  readonly catalog: SetupCatalog;
  /** Build-time-vendored SVG of the connector that opened the wizard (trusted). */
  readonly logoSvg: string;
  /** Return to the gallery. */
  readonly onBack: () => void;
  /** Successful seeding — the modal adds these names to its clientSeeded set. */
  readonly onSeeded: (names: readonly string[]) => void;
}

/**
 * BYO-client setup wizard: an intro screen plus catalog.steps.length + 1
 * numbered steps, the last one always the credentials form. Screen 0 is the
 * intro; 1..steps.length are content steps; the final screen seeds via
 * config:seed-client and only counts success once the Keychain re-read
 * confirms it. A failed save keeps the pasted values so the user can retry.
 */
export function ConnectorSetupWizard({
  catalog,
  logoSvg,
  onBack,
  onSeeded,
}: ConnectorSetupWizardProps): ReactElement {
  const [screen, setScreen] = useState(0);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SeedClientResult | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const total = catalog.steps.length + 1;
  const saved = saveResult !== null && saveResult.ok;

  async function handleSave(): Promise<void> {
    if (saving || saved) return;
    if (clientId.trim() === '') {
      setFieldError('Enter your Client ID.');
      return;
    }
    const secret = clientSecret.trim();
    if (catalog.credentials.secretRequired && secret === '') {
      // Hard UI gate for secret-requiring catalogs (Google): config:seed-client
      // is never called without a secret. Secret-less catalogs (Slack) never
      // reach here — their field isn't rendered — and seed with the key omitted.
      setFieldError(catalog.credentials.secretRequiredError ?? 'A client secret is required.');
      return;
    }
    setFieldError(null);
    setSaving(true);
    setSaveResult(null);
    try {
      const result = await window.xcg.configSeedClient(
        [...catalog.credentials.targets],
        clientId,
        secret === '' ? undefined : clientSecret,
      );
      if (!mountedRef.current) return;
      setSaveResult(result);
      if (result.ok) onSeeded(result.seeded);
    } catch (err) {
      if (!mountedRef.current) return;
      setSaveResult({ ok: false, error: err instanceof Error ? err.message : 'unknown error' });
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  const step = screen >= 1 && screen <= catalog.steps.length ? catalog.steps[screen - 1] : undefined;

  return (
    <div className={styles['wizard']}>
      <button
        type="button"
        className={styles['back']}
        onClick={() => (screen === 0 ? onBack() : setScreen(screen - 1))}
      >
        ← Back
      </button>

      {screen === 0 ? (
        <>
          <div className={styles['head']}>
            <span
              className={styles['logo']}
              aria-hidden="true"
              // Trusted, static, build-time-vendored SVG (no user input).
              dangerouslySetInnerHTML={{ __html: logoSvg }}
            />
            <h3 className={styles['title']}>{catalog.title}</h3>
          </div>
          {catalog.introParagraphs.map((p) => (
            <p key={p} className={styles['text']}>
              {p}
            </p>
          ))}
          <p className={styles['warn']}>{catalog.warning}</p>
          <p className={styles['stepsLine']}>
            {total} steps:{' '}
            {[...catalog.steps.map((s) => s.shortName), catalog.credentials.shortName].join(' → ')}
          </p>
          <div className={styles['navRow']}>
            <button type="button" className={styles['primaryBtn']} onClick={() => setScreen(1)}>
              {catalog.startLabel}
            </button>
          </div>
        </>
      ) : step !== undefined ? (
        <>
          <div className={styles['counter']}>
            Step {screen}/{total}
          </div>
          <h3 className={styles['title']}>{step.title}</h3>
          {step.body}
          <div className={styles['navRow']}>
            <button
              type="button"
              className={styles['primaryBtn']}
              onClick={() => setScreen(screen + 1)}
            >
              {step.advanceLabel}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={styles['counter']}>
            Step {total}/{total}
          </div>
          <h3 className={styles['title']}>{catalog.credentials.title}</h3>
          <div className={`${styles['block']} ${styles['blockFields']}`}>
            <label className={styles['field']}>
              <span className={styles['fieldLabel']}>Client ID</span>
              <input
                type="text"
                className={styles['input']}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                disabled={saving || saved}
              />
              {catalog.credentials.idHint !== undefined ? (
                <span className={styles['fieldHint']}>{catalog.credentials.idHint}</span>
              ) : null}
            </label>
            {catalog.credentials.secretRequired ? (
              <label className={styles['field']}>
                <span className={styles['fieldLabel']}>Client secret</span>
                <input
                  type="password"
                  className={styles['input']}
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  disabled={saving || saved}
                />
              </label>
            ) : null}
          </div>
          {fieldError !== null ? (
            <p className={styles['fieldError']} role="alert">
              {fieldError}
            </p>
          ) : null}
          {saveResult !== null && !saveResult.ok ? (
            // Friendly first line with the action; the raw handler error stays
            // as a technical second line (it is already secret-free).
            <div className={styles['bannerError']} role="alert">
              Couldn’t save to your Keychain — your pasted values are kept, so you can try
              again.
              <span className={styles['bannerErrorDetail']}>{saveResult.error}</span>
            </div>
          ) : null}
          {saveResult !== null && saveResult.ok ? (
            <>
              <div className={styles['bannerSuccess']}>{catalog.credentials.successMessage}</div>
              {saveResult.warnings.map((w) => (
                <p key={w} className={styles['warnNote']}>
                  {w}
                </p>
              ))}
            </>
          ) : null}
          <div className={styles['navRow']}>
            {saved ? (
              <button type="button" className={styles['primaryBtn']} onClick={onBack}>
                Back to connectors
              </button>
            ) : (
              <button
                type="button"
                className={styles['primaryBtn']}
                onClick={() => void handleSave()}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save and finish'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
