import { query } from "@anthropic-ai/claude-agent-sdk";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// ── Config ────────────────────────────────────────────────────────────────────

const LF_BASE = "https://api.lightfield.app/v1";
const LF_VERSION = "2026-03-01";
const SLACK_CHANNEL = "C0AKT2210U9"; // #elevatemsp-primary-gtm

const ACTIVE_STAGE_IDS = new Set([
  "opt_a24e8919-26cc-41de-92e0-7ea8b2f6257f", // New
  "opt_803b1e4b-2447-40a4-92a0-5eeffe6e454f", // Engaged
  "opt_b78904ee-0d98-401c-84a2-c18c2fd58ae0", // Qualifying
  "opt_acae8cda-06e0-4b6a-804e-f9dadf917c47", // Proposal
  "opt_fd2d3b6b-f516-4325-ab69-441eb6d08698", // Closing
]);

const STAGE_LABELS: Record<string, string> = {
  "opt_a24e8919-26cc-41de-92e0-7ea8b2f6257f": "New",
  "opt_803b1e4b-2447-40a4-92a0-5eeffe6e454f": "Engaged",
  "opt_b78904ee-0d98-401c-84a2-c18c2fd58ae0": "Qualifying",
  "opt_acae8cda-06e0-4b6a-804e-f9dadf917c47": "Proposal",
  "opt_fd2d3b6b-f516-4325-ab69-441eb6d08698": "Closing",
};

// ── Lightfield helpers ────────────────────────────────────────────────────────

function lfHeaders(): Record<string, string> {
  const key = process.env.LIGHTFIELD_API_KEY;
  if (!key) throw new Error("LIGHTFIELD_API_KEY not set");
  return {
    Authorization: `Bearer ${key}`,
    "Lightfield-Version": LF_VERSION,
    "Content-Type": "application/json",
  };
}

async function lfGet(path: string) {
  const res = await fetch(`${LF_BASE}${path}`, { headers: lfHeaders() });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return res.json();
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface LFField {
  valueType: string;
  value: unknown;
}

interface LFRecord {
  id: string;
  createdAt: string;
  fields: Record<string, LFField>;
  relationships: Record<string, { values: string[] }>;
  httpLink: string;
}

interface ContactSummary {
  name: string;
  email: string | null;
  title: string | null;
}

interface OppAnalysis {
  nextStep: string;
  emailSubject: string;
  emailBody: string;
}

// ── Gmail IMAP ────────────────────────────────────────────────────────────────

interface EmailSnippet {
  date: Date;
  from: string;
  to: string;
  subject: string;
  snippet: string;
}

async function fetchEmailsForContacts(contacts: ContactSummary[]): Promise<string> {
  const contactEmails = contacts.filter((c) => c.email).map((c) => c.email!);
  if (contactEmails.length === 0) return "";

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    console.warn("  GMAIL_USER or GMAIL_APP_PASSWORD not set — skipping email fetch.");
    return "";
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: gmailUser, pass: gmailPass },
    logger: false,
  });

  const since = new Date();
  since.setDate(since.getDate() - 90);

  const snippets: EmailSnippet[] = [];

  try {
    await client.connect();
  } catch {
    console.warn("  Gmail IMAP unavailable (network blocked) — skipping email history.");
    await client.logout().catch(() => {});
    return "";
  }

  try {
    for (const mailbox of ["INBOX", "[Gmail]/Sent Mail"]) {
      try {
        await client.mailboxOpen(mailbox);
      } catch {
        continue;
      }

      for (const email of contactEmails) {
        // Inbox: look for emails from the contact; Sent: look for emails to the contact
        const criteria = mailbox === "INBOX" ? { from: email, since } : { to: email, since };
        let uids = await client.search(criteria, { uid: true });
        uids = uids.slice(-5); // most recent 5 per contact per mailbox
        if (uids.length === 0) continue;

        for await (const msg of client.fetch(uids, { source: true, uid: true })) {
          const parsed = await simpleParser(msg.source);
          const text = (parsed.text ?? "").slice(0, 600).replace(/\s+/g, " ").trim();
          if (!text) continue;

          const toAddr = parsed.to
            ? Array.isArray(parsed.to)
              ? parsed.to.map((a) => a.text).join(", ")
              : parsed.to.text
            : "";

          snippets.push({
            date: parsed.date ?? new Date(),
            from: parsed.from?.text ?? "",
            to: toAddr,
            subject: parsed.subject ?? "(no subject)",
            snippet: text,
          });
        }
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }

  if (snippets.length === 0) return "";

  snippets.sort((a, b) => b.date.getTime() - a.date.getTime());

  return snippets
    .map(
      (s) =>
        `### Email: ${s.subject}\nDate: ${s.date.toLocaleDateString("en-US")}\nFrom: ${s.from}\nTo: ${s.to}\n${s.snippet}`
    )
    .join("\n\n");
}

// ── Lightfield data fetching ──────────────────────────────────────────────────

async function fetchAllOpportunities(): Promise<LFRecord[]> {
  const all: LFRecord[] = [];
  let offset = 0;
  while (true) {
    const page = await lfGet(`/opportunities?limit=25&offset=${offset}`);
    all.push(...page.data);
    if (all.length >= page.totalCount) break;
    offset += 25;
  }
  return all.filter((opp) => {
    const stage = opp.fields.$stage?.value as string | null;
    return stage && ACTIVE_STAGE_IDS.has(stage);
  });
}

async function fetchContact(id: string): Promise<LFRecord | null> {
  try {
    return await lfGet(`/contacts/${id}`);
  } catch {
    return null;
  }
}

async function fetchNote(id: string): Promise<{ title: string; content: string } | null> {
  try {
    const rec = await lfGet(`/notes/${id}`);
    const title = (rec.fields.$title?.value as string) ?? "";
    const content = (rec.fields.$content?.value as string) ?? "";
    if (!content) return null;
    return { title, content };
  } catch {
    return null;
  }
}

async function fetchMeeting(id: string): Promise<{ title: string; summary: string } | null> {
  try {
    const rec = await lfGet(`/meetings/${id}`);
    const title = (rec.fields.$title?.value as string) ?? "";
    const summary = (rec.fields.$postMeetingSummary?.value as string) ?? "";
    if (!summary) return null;
    return { title, summary };
  } catch {
    return null;
  }
}

async function getChampionContacts(opp: LFRecord): Promise<ContactSummary[]> {
  const ids: string[] = opp.relationships.$champion?.values ?? [];
  const contacts = await Promise.all(ids.map(fetchContact));
  return contacts
    .filter((c): c is LFRecord => c !== null)
    .map((c) => {
      const nameField = c.fields.$name?.value as { firstName?: string; lastName?: string } | null;
      const name = nameField
        ? [nameField.firstName, nameField.lastName].filter(Boolean).join(" ")
        : "Unknown";
      const emailField = c.fields.$email?.value;
      const email = Array.isArray(emailField) ? emailField[0] ?? null : (emailField as string | null);
      const title = c.fields.$title?.value as string | null;
      return { name, email, title };
    });
}

async function getEngagementHistory(opp: LFRecord): Promise<string> {
  const noteIds: string[] = opp.relationships.$note?.values ?? [];
  const meetingIds: string[] = opp.relationships.$meeting?.values ?? [];

  const [notes, meetings] = await Promise.all([
    Promise.all(noteIds.map(fetchNote)),
    Promise.all(meetingIds.map(fetchMeeting)),
  ]);

  const parts: string[] = [];

  for (const note of notes.filter((n): n is { title: string; content: string } => n !== null)) {
    parts.push(`### Note: ${note.title}\n${note.content}`);
  }

  for (const meeting of meetings.filter((m): m is { title: string; summary: string } => m !== null)) {
    parts.push(`### Meeting Summary: ${meeting.title}\n${meeting.summary}`);
  }

  return parts.join("\n\n");
}

// ── Claude analysis ───────────────────────────────────────────────────────────

async function analyzeOpportunity(
  oppName: string,
  stage: string,
  statusSummary: string,
  contacts: ContactSummary[],
  engagementHistory: string,
  recentEmails: string
): Promise<OppAnalysis> {
  const contactInfo =
    contacts.length > 0
      ? contacts
          .map((c) => `${c.name}${c.title ? ` (${c.title})` : ""}${c.email ? ` <${c.email}>` : ""}`)
          .join(", ")
      : "No contacts linked";

  const historySection = engagementHistory
    ? `\n\n## Full engagement history (notes & meeting summaries)\n${engagementHistory}`
    : "";

  const emailSection = recentEmails
    ? `\n\n## Recent emails (last 90 days)\n${recentEmails}`
    : "";

  const prompt = `You are ghostwriting emails for Russ Morton, Founder/CEO of Elevate. Elevate helps MSPs (managed service providers) build and launch AI practices for their business clients.

## Russ's voice — follow this exactly

TONE: Warm but direct. Founder energy, not salesperson. Confident, never hedging. Genuine enthusiasm without being performative.

OPENINGS: First name only for warm contacts (just "Joel," or "Richard,"). Use "Hi [Name]," for newer contacts. NEVER "Hope this finds you well," NEVER "Dear," NEVER "I was wondering if perhaps."

STRUCTURE: Short punchy paragraphs — 1–2 sentences max. Get to the point in the first 2 sentences. Every email has a clear forward lean and a next step.

SIGN-OFF: Always close with \`-Russ\` (dash before name). Add a warm one-liner before it: "Talk soon!", "Let me know what you're thinking!", "Cheers!" etc.

SUBJECT LINES: Clear and direct. Use "Follow up from Russ Morton (Founder @ Elevate)" or personalized ("Great meeting you in [City]!") for first-touch. For check-ins, short and specific.

LENGTH BY TYPE:
- Check-in / follow-up ping: 1–3 sentences
- Post-call follow-up (no proposal): 80–150 words
- Intro acceptance: 4–6 sentences

SIGNATURE PHRASES (use when natural):
- "I'm super glad to have met you" — post-conference warmth
- "I genuinely think we're onto something"
- "I can definitely appreciate..." — empathy bridge before a pivot
- "Love to connect!" / "Love to try to get something on the calendar"
- "Happy to use your/my booking link" / "just book 30 min"
- "In addition to creating value, I also think it would be fun!!"
- "No obligation!" — when removing pressure
- "I'd prefer path #2 above -- but naturally, don't want to get out of order."
- "ex-Datto" in parentheses as credential in first-contact emails

NEVER USE: "Best,", "Regards,", "Kind regards,", "Sincerely,", "circle back", "synergy", "leverage", passive constructions, dense paragraphs, or "Following up" in subject lines.

---

## Opportunity: ${oppName}
Stage: ${stage}
Key contacts: ${contactInfo}

## CRM status summary (AI-generated)
${statusSummary}${historySection}${emailSection}

---

Based on all of the above, produce:

1. NEXT_STEP: A single crisp sentence (max 20 words) — the one most important thing Russ needs to do right now to move this deal forward.

2. EMAIL_SUBJECT: A subject line in Russ's style (clear, direct, not clever).

3. EMAIL_BODY: An email written in Russ's voice. Reference specific details from the engagement history and recent emails — be concrete, not generic. Match the length to the situation (check-in = 1–3 sentences; substantive follow-up = 80–150 words). Close with -Russ.

Respond in exactly this format:
NEXT_STEP: <text>
EMAIL_SUBJECT: <text>
EMAIL_BODY:
<email body text>`;

  let text = "";
  for await (const message of query({ prompt })) {
    if (message.type === "result" && message.subtype === "success") {
      text = message.result;
    }
  }

  const nextStepMatch = text.match(/NEXT_STEP:\s*(.+)/);
  const subjectMatch = text.match(/EMAIL_SUBJECT:\s*(.+)/);
  const bodyMatch = text.match(/EMAIL_BODY:\s*\n([\s\S]+)/);

  return {
    nextStep: nextStepMatch?.[1]?.trim() ?? "Follow up with the contact.",
    emailSubject: subjectMatch?.[1]?.trim() ?? `Checking in — ${oppName}`,
    emailBody: bodyMatch?.[1]?.trim() ?? "(Could not generate email draft)",
  };
}

// ── Slack posting ─────────────────────────────────────────────────────────────

interface SlackPostResult {
  ts: string;
}

async function slackPost(payload: object): Promise<SlackPostResult> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not set");

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = (await res.json()) as { ok: boolean; error?: string; ts?: string };
  if (!data.ok) throw new Error(`Slack error: ${data.error}`);
  return { ts: data.ts! };
}

function oppThreadBlocks(opp: {
  name: string;
  stage: string;
  link: string;
  analysis: OppAnalysis;
  contacts: ContactSummary[];
}): object[] {
  const primaryContact = opp.contacts[0];
  const toLine = primaryContact?.email
    ? `*To:* ${primaryContact.name} <${primaryContact.email}>`
    : primaryContact
      ? `*To:* ${primaryContact.name}`
      : `*To:* _(no contact linked)_`;

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${opp.link}|${opp.name}>* · ${opp.stage}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Next step:* ${opp.analysis.nextStep}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Draft email:*`,
          toLine,
          `*Subject:* ${opp.analysis.emailSubject}`,
          "```",
          opp.analysis.emailBody,
          "```",
        ].join("\n"),
      },
    },
  ];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching active opportunities from Lightfield...");
  const opps = await fetchAllOpportunities();
  console.log(`Found ${opps.length} active opportunities.`);

  if (opps.length === 0) {
    console.log("No active opportunities — skipping Slack post.");
    return;
  }

  const results: Array<{
    name: string;
    stage: string;
    link: string;
    analysis: OppAnalysis;
    contacts: ContactSummary[];
  }> = [];

  for (const opp of opps) {
    const name = (opp.fields.$name?.value as string) ?? "Unnamed Opportunity";
    const stageId = opp.fields.$stage?.value as string | null;
    const stage = stageId ? (STAGE_LABELS[stageId] ?? stageId) : "Unknown";
    const statusSummary = (opp.fields.$opportunityStatus?.value as string) ?? "";

    if (!statusSummary) {
      console.log(`  Skipping "${name}" — no AI status summary available.`);
      continue;
    }

    console.log(`  Analyzing: ${name} (${stage})...`);
    const [contacts, engagementHistory] = await Promise.all([
      getChampionContacts(opp),
      getEngagementHistory(opp),
    ]);

    const recentEmails = await fetchEmailsForContacts(contacts);
    if (recentEmails) {
      console.log(`    Found email history for "${name}".`);
    }

    const analysis = await analyzeOpportunity(name, stage, statusSummary, contacts, engagementHistory, recentEmails);
    results.push({ name, stage, link: opp.httpLink, analysis, contacts });
  }

  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  console.log(`\nPosting digest for ${results.length} opportunities to Slack...`);

  const header = await slackPost({
    channel: SLACK_CHANNEL,
    text: `📬 Weekly Opportunity Digest — ${today}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `📬 Weekly Opportunity Digest — ${today}` },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${results.length} active opportunities* need Russ's attention this week. Details in thread 👇`,
        },
      },
    ],
  });

  for (const opp of results) {
    await slackPost({
      channel: SLACK_CHANNEL,
      thread_ts: header.ts,
      text: opp.name,
      blocks: oppThreadBlocks(opp),
    });
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
