// Connector brand logos, vendored as static SVGs (no CDN at runtime — the app
// must not fetch anything). Source: Simple Icons (https://simpleicons.org),
// licensed CC0 1.0. Each file was normalized at vendor time to a single
// <path fill="currentColor"> so it tints to the surrounding text color; verified
// to contain no <script>/<foreignObject>/<style>/<image>. See assets/logos/.
//
// Imported with Vite's `?raw` so the markup is bundled into the JS and rendered
// inline (dangerouslySetInnerHTML on trusted static assets) — the only way to
// tint a multi-path glyph with currentColor without an <img>.

import notion from '../assets/logos/notion.svg?raw';
import linear from '../assets/logos/linear.svg?raw';
import atlassian from '../assets/logos/atlassian.svg?raw';
import github from '../assets/logos/github.svg?raw';
import stripe from '../assets/logos/stripe.svg?raw';
import apollo from '../assets/logos/apollo.svg?raw';
import slack from '../assets/logos/slack.svg?raw';
import gmail from '../assets/logos/gmail.svg?raw';
import googlecalendar from '../assets/logos/googlecalendar.svg?raw';
import googledrive from '../assets/logos/googledrive.svg?raw';
import asana from '../assets/logos/asana.svg?raw';
import hubspot from '../assets/logos/hubspot.svg?raw';
// Hand-drawn terminal glyph (prompt chevron + underscore), not from Simple
// Icons — same single-path fill="currentColor" contract as the vendored set.
import terminal from '../assets/logos/terminal.svg?raw';

/** Logo SVG markup keyed by the catalog entry's `logo` slug. */
export const LOGO_SVGS: Readonly<Record<string, string>> = {
  notion,
  linear,
  atlassian,
  github,
  stripe,
  apollo,
  slack,
  gmail,
  googlecalendar,
  googledrive,
  asana,
  hubspot,
  terminal,
};
