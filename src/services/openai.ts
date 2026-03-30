import OpenAI from "openai";

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export async function extractNotificationBody(rawText: string): Promise<string | null> {
  const openai = getClient();
  if (!openai) {
    console.warn("[openai] OPENAI_API_KEY not set — skipping extraction");
    return null;
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 60,
      messages: [
        {
          role: "system",
          content:
            "You extract the question or message an AI coding agent is asking the user from terminal output. " +
            "Return ONLY the question or message — no explanation, no quotes, no extra text. " +
            "Max 150 characters. If no clear question is found, return an empty string.",
        },
        {
          role: "user",
          content: rawText,
        },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim() ?? "";
    return text.length > 0 ? text : null;
  } catch (err) {
    console.error("[openai] extraction failed:", err);
    return null;
  }
}
