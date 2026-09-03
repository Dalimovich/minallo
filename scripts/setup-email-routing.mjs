#!/usr/bin/env node
// Set up Cloudflare Email Routing for minallo.de
//
// Required env (PowerShell):
//   $env:CF_API_TOKEN  = "<token with Zone:Email Routing:Edit + Zone:Zone:Read>"
//   $env:CF_ZONE_ID    = "<minallo.de zone id>"
//   $env:DEST_EMAIL    = "mohamedali.mariam@gmail.com"   # your real inbox
//
// Run:
//   node scripts/setup-email-routing.mjs
//
// What this does:
//   1. Enables Email Routing on the zone (idempotent).
//   2. Adds DEST_EMAIL as a destination address (Cloudflare will send a
//      verification email — click the link before re-running).
//   3. Creates one forwarding rule per alias below.
//   4. Creates a catch-all rule that DROPS unknown mail (prevents spam
//      hitting addresses you never published).
//   5. Prints the SPF + DMARC + noreply DNS records to add.

const API = 'https://api.cloudflare.com/client/v4';

const TOKEN = process.env.CF_API_TOKEN;
const ZONE  = process.env.CF_ZONE_ID;
const DEST  = process.env.DEST_EMAIL;

if (!TOKEN || !ZONE || !DEST) {
  console.error('Missing CF_API_TOKEN, CF_ZONE_ID, or DEST_EMAIL env var.');
  process.exit(1);
}

const ALIASES = [
  'hello',
  'info',
  'support',
  'billing',
  'privacy',
  'security',
  'legal',
  // noreply is NOT forwarded — we drop inbound to it (outbound-only address).
];

const DOMAIN = 'minallo.de';

async function cf(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(`${method} ${path} failed: ${JSON.stringify(json.errors)}`);
  }
  return json.result;
}

async function enableRouting() {
  console.log('→ Enabling Email Routing on zone...');
  try {
    await cf('POST', `/zones/${ZONE}/email/routing/enable`);
    console.log('  enabled.');
  } catch (e) {
    console.log('  already enabled (or insufficient scope).');
  }
}

async function addDestination() {
  console.log(`→ Adding destination ${DEST}...`);
  try {
    await cf('POST', `/accounts/${await getAccountId()}/email/routing/addresses`, { email: DEST });
    console.log('  added — CHECK YOUR INBOX and click the verification link.');
  } catch (e) {
    console.log(`  exists or already added: ${e.message}`);
  }
}

async function getAccountId() {
  const zone = await cf('GET', `/zones/${ZONE}`);
  return zone.account.id;
}

async function listRules() {
  return cf('GET', `/zones/${ZONE}/email/routing/rules`);
}

async function createForwardRule(alias) {
  const localPart = alias;
  const fullAddr = `${alias}@${DOMAIN}`;
  console.log(`→ Forward ${fullAddr} → ${DEST}`);
  await cf('POST', `/zones/${ZONE}/email/routing/rules`, {
    name: `forward ${localPart}`,
    enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: fullAddr }],
    actions:  [{ type: 'forward', value: [DEST] }]
  });
}

async function createDropNoreply() {
  console.log(`→ Drop inbound to noreply@${DOMAIN}`);
  await cf('POST', `/zones/${ZONE}/email/routing/rules`, {
    name: 'drop noreply (outbound-only)',
    enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: `noreply@${DOMAIN}` }],
    actions:  [{ type: 'drop' }]
  });
}

async function createCatchAll() {
  console.log(`→ Catch-all: drop everything else`);
  await cf('PUT', `/zones/${ZONE}/email/routing/rules/catch_all`, {
    name: 'catch-all drop',
    enabled: true,
    matchers: [{ type: 'all' }],
    actions:  [{ type: 'drop' }]
  });
}

function printDnsRecords() {
  console.log(`
================================================================
DNS records to verify in Cloudflare → ${DOMAIN} → DNS
================================================================

Email Routing will auto-create three MX records pointing to
route1.mx.cloudflare.net / route2 / route3. Confirm they exist.

Then add these TXT records (Cloudflare → DNS → Add record):

  Type  Name              Content
  ----  ----------------  --------------------------------------------------
  TXT   ${DOMAIN}      "v=spf1 include:_spf.mx.cloudflare.net ~all"
  TXT   _dmarc            "v=DMARC1; p=quarantine; rua=mailto:legal@${DOMAIN}; ruf=mailto:legal@${DOMAIN}; fo=1; adkim=s; aspf=s"
  TXT   noreply._domainkey   <from your transactional sender (Resend/Postmark/SES) — paste their DKIM record>

Notes:
  - SPF "~all" = softfail. Tighten to "-all" once you've confirmed every
    legit sender (Stripe receipts, Supabase Auth) is either using your
    domain via DKIM, or sending from its own domain (NOT @minallo.de).
  - DMARC starts at p=quarantine. Watch RUA reports for two weeks, then
    move to p=reject once aligned.
  - DKIM record content comes from whoever sends mail AS noreply@minallo.de
    (Supabase SMTP, Resend, Postmark, etc). Add their selector record verbatim.
================================================================
`);
}

(async () => {
  await enableRouting();
  await addDestination();

  const existing = await listRules();
  const have = new Set(existing
    .flatMap(r => r.matchers || [])
    .filter(m => m.field === 'to')
    .map(m => m.value));

  for (const a of ALIASES) {
    const addr = `${a}@${DOMAIN}`;
    if (have.has(addr)) { console.log(`  skip ${addr} (rule exists)`); continue; }
    await createForwardRule(a);
  }

  if (!have.has(`noreply@${DOMAIN}`)) await createDropNoreply();
  else console.log('  skip noreply drop (rule exists)');

  await createCatchAll();
  printDnsRecords();

  console.log('\nDone. Verify the destination email before mail will actually forward.');
})().catch(e => { console.error(e); process.exit(1); });
