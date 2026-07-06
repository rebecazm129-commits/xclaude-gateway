// Advisory format checks for BYO OAuth clients, per connector, used by the
// config:seed-client handler. Warnings only — a wrong-looking value may still
// be what the provider issued, so nothing here ever blocks the write. The
// table lives in the MAIN process on purpose: the renderer never supplies
// patterns, so the privileged process only runs regexes it owns.

interface FormatHint {
  readonly test: RegExp;
  readonly message: string;
}

interface ClientFormatHints {
  readonly id?: FormatHint;
  readonly secret?: FormatHint;
}

const GOOGLE_HINTS: ClientFormatHints = {
  id: {
    test: /\.apps\.googleusercontent\.com$/,
    message:
      'The Client ID does not end in ".apps.googleusercontent.com" — saved anyway, double-check it.',
  },
  secret: {
    test: /^GOCSPX-/,
    message: 'The Client secret does not start with "GOCSPX-" — saved anyway, double-check it.',
  },
};

// Slack public Client ID shape: digits.digits (same check as the seeding spike).
const SLACK_HINTS: ClientFormatHints = {
  id: {
    test: /^[0-9]+\.[0-9]+$/,
    message:
      'The Client ID does not look like a Slack Client ID (digits.digits, e.g. 1234567890.1234567890) — saved anyway, double-check it.',
  },
};

const HINTS_BY_CONNECTOR: Readonly<Record<string, ClientFormatHints>> = {
  gmail: GOOGLE_HINTS,
  calendar: GOOGLE_HINTS,
  drive: GOOGLE_HINTS,
  slack: SLACK_HINTS,
};

// Advisory warnings for one seed call. Connectors seeded together
// (gmail/calendar/drive) share one client, so the first name with a known
// shape decides. Unknown connectors get no checks — no shape to compare
// against. Messages never echo the checked values.
export function seedClientWarnings(
  names: readonly string[],
  clientId: string,
  clientSecret: string | undefined,
): string[] {
  const hints = names.map((n) => HINTS_BY_CONNECTOR[n]).find((h) => h !== undefined);
  if (hints === undefined) return [];
  const warnings: string[] = [];
  if (hints.id !== undefined && !hints.id.test.test(clientId)) {
    warnings.push(hints.id.message);
  }
  if (
    hints.secret !== undefined &&
    clientSecret !== undefined &&
    !hints.secret.test.test(clientSecret)
  ) {
    warnings.push(hints.secret.message);
  }
  return warnings;
}
