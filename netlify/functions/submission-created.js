// netlify/functions/submission-created.js
//
// Netlify automatically calls any function named "submission-created" right after
// ANY form on this site is submitted (no extra webhook config needed in the UI).
// This one:
//   1. Reads the submitted form fields
//   2. Asks Claude (Haiku) to turn them into a clean markdown project brief
//   3. Posts that markdown to Discord as a file attachment
//
// Required environment variables (set in Netlify site settings -> Environment variables):
//   CLAUDE_API_KEY       - Anthropic API key
//   DISCORD_WEBHOOK_URL   - Discord webhook URL for the channel briefs should land in

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const data = (body.payload && body.payload.data) || {};
    const formName = (body.payload && body.payload.form_name) || "unknown-form";

    // Ignore Netlify's own spam/honeypot flag if present
    if (data["bot-field"]) {
      return { statusCode: 200, body: "ignored (honeypot)" };
    }

    const fields = Object.keys(data)
      .filter((k) => k !== "bot-field" && k !== "form-name")
      .map((k) => `${k}: ${data[k]}`)
      .join("\n");

    const markdown = await buildBriefMarkdown(formName, fields);
    await postToDiscord(markdown, data.sender || data.reach || "New submission");

    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("submission-created error:", err);
    // Still return 200 so Netlify doesn't retry-storm; the error is logged for debugging.
    return { statusCode: 200, body: "error logged" };
  }
};

async function buildBriefMarkdown(formName, rawFields) {
  const systemPrompt = `You turn raw website-contact-form submissions into a clean, well-organized markdown brief for a web design/development team. Use clear headings, bullet points where helpful, and keep the client's own words intact rather than paraphrasing their vision. If a field is empty or missing, omit it rather than noting it's blank. Output ONLY the markdown, no preamble or commentary.`;

  const userPrompt = `Form: ${formName}\n\nRaw submitted fields:\n${rawFields}\n\nWrite this up as a markdown project brief.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.CLAUDE_API_KEY,
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
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const textBlock = (json.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text : "*(Claude returned no text)*";
}

async function postToDiscord(markdown, label) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
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
