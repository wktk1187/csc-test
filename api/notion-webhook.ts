import { VercelRequest, VercelResponse } from '@vercel/node';
import { Client as Notion } from '@notionhq/client';
import crypto from 'crypto';
import fetch from 'node-fetch';

const notionVerificationToken = process.env.NOTION_VERIFICATION_TOKEN as string;
const notion = new Notion({ auth: process.env.NOTION_TOKEN });
const DIFY_API_URL = process.env.DIFY_API_URL ?? 'https://api.dify.ai/v1';
const DIFY_API_KEY = process.env.DIFY_API_KEY as string;
const DIFY_KB_ID = process.env.DIFY_KB_ID as string;

function verifySignature(rawBody: Buffer, signature: string | undefined) {
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', notionVerificationToken).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// Main handler
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  // Build rawBody safely
  let rawBody: Buffer;
  if (Buffer.isBuffer(req.body)) {
    rawBody = req.body as Buffer;
  } else if (typeof req.body === 'string') {
    rawBody = Buffer.from(req.body);
  } else {
    rawBody = Buffer.from(JSON.stringify(req.body || {}));
  }

  const signature = req.headers['x-notion-signature'] as string | undefined;

  // Verification request
  try {
    const bodyJSON = JSON.parse(rawBody.toString() || '{}');
    if (bodyJSON.verification_token) {
      console.log('Received Notion verification_token:', bodyJSON.verification_token);
      return res.json({ verification_token: bodyJSON.verification_token });
    }
  } catch (_) {
    // ignore JSON parse error for verification
  }

  if (!verifySignature(rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const payload = JSON.parse(rawBody.toString());
  const events = payload.events as any[];

  for (const ev of events) {
    if (ev.object !== 'page') continue;
    const changed = ev.changed_properties as any[];
    const approvedChange = changed.find((p: any) => p.property_name === '承認' || p.property_id === '承認');
    if (!approvedChange) continue;
    if (approvedChange.after === true) {
      const pageId = ev.id;
      const page = await notion.pages.retrieve({ page_id: pageId });
      const props: any = (page as any).properties;
      const title = props['質問']?.title?.[0]?.plain_text ?? 'Untitled';
      const answer = props['回答']?.rich_text?.[0]?.plain_text ?? '';
      await pushToDify(title, answer);
    }
  }

  res.json({ received: true });
}

async function pushToDify(question: string, answer: string) {
  if (!DIFY_API_KEY || !DIFY_KB_ID) return;
  await fetch(`${DIFY_API_URL}/knowledge_base_documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DIFY_API_KEY}`,
    },
    body: JSON.stringify({
      knowledge_base_id: DIFY_KB_ID,
      content: `${question}\n${answer}`,
    }),
  });
} 