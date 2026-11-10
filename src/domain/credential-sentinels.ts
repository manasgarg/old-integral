export const SENTINEL = "integral-managed-credential";

export const OAUTH_SENTINEL = `e30.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: SENTINEL },
  }),
).toString("base64url")}.${SENTINEL}`;
