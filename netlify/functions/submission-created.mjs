// netlify/functions/submission-created.mjs
//
// Called directly by contact.html right after a successful form submission.
// This one:
//   1. Reads the submitted form fields
//   2. Asks Claude (Haiku) to turn them into a clean markdown project brief
//   3. Posts that markdown to Discord as a file attachment
//
// Required environment variables (set in Netlify site settings -> Environment variables):
//   CLAUDE_API_KEY        - Anthropic API key
//   DISCORD_WEBHOOK_URL   - Discord webhook URL for the channel briefs should land in
//
// DIAGNOSTIC MODE: visit this function's URL directly in a browser (a plain GET
// request) to see whether the env vars are actually present at runtime, their
// length, and a masked preview - without ever exposing the full secret.
//
// Accepts a direct call: { "formName": "become-a-client", "fields": { "first_name": "...", ... } }

function maskSecret(value) {
  if (!value) return { present: false };
  return {
    present: true,
    length: value.length,
    preview: value.length > 12
      ? value.slice(0, 8) + "..." + value.slice(-4)
      : "(too short to preview safely)",
  };
}

export default async (req, context) => {
  // Diagnostic mode: GET request just reports env var status, calls nothing external.
  if (req.method === "GET") {
    const claudeKey = Netlify.env.get("CLAUDE_API_KEY");
    const discordUrl = Netlify.env.get("DISCORD_WEBHOOK_URL");
    return new Response(
      JSON.stringify(
        {
          CLAUDE_API_KEY: maskSecret(claudeKey),
          DISCORD_WEBHOOK_URL: maskSecret(discordUrl),
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json();
    const data = body.fields || {};
    const formName = body.formName || "unknown-form";

    // Ignore the spam honeypot if it's somehow filled in
    if (data["bot-field"]) {
      return new Response("ignored (honeypot)", { status: 200 });
    }

    const fields = Object.keys(data)
      .filter((k) => k !== "bot-field" && k !== "form-name")
      .map((k) => `${k}: ${data[k]}`)
      .join("\n");

    const markdown = await buildBriefMarkdown(formName, fields);
    const label = [data.first_name, data.last_name].filter(Boolean).join(" ") || data.email || "New submission";
    await postToDiscord(markdown, label);

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("submission-created error:", err);
    return new Response(String(err), { status: 500 });
  }
};

async function buildBriefMarkdown(formName, rawFields) {
  const apiKey = Netlify.env.get("CLAUDE_API_KEY");

  const systemPrompt = `You turn raw website-contact-form submissions into a clean, well-organized markdown brief for a web design/development team. Use clear headings, bullet points where helpful, and keep the client's own words intact rather than paraphrasing their vision. If a field is empty or missing, omit it rather than noting it's blank. Output ONLY the markdown, no preamble or commentary.`;

  const userPrompt = `Form: ${formName}\n\nRaw submitted fields:\n${rawFields}\n\nWrite this up as a markdown project brief.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    const keyInfo = maskSecret(apiKey);
    throw new Error(`Claude API error ${res.status}: ${errText} | key seen by function: ${JSON.stringify(keyInfo)}`);
  }

  const json = await res.json();
  const textBlock = (json.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text : "*(Claude returned no text)*";
}

async function postToDiscord(markdown, label) {
  const webhookUrl = Netlify.env.get("DISCORD_WEBHOOK_URL");
  if (!webhookUrl) throw new Error("DISCORD_WEBHOOK_URL is not set");

  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({ content: `**New brief received** — ${label}` })
  );
  form.append(
    "files[0]",
    new Blob([markdown], { type: "text/markdown" }),
    "brief.md"
  );

  const res = await fetch(webhookUrl, { method: "POST", body: form });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Discord webhook error ${res.status}: ${errText}`);
  }
}
