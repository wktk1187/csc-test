import { VercelRequest, VercelResponse } from '@vercel/node';
import { Client as Notion } from '@notionhq/client';
import fetch from 'node-fetch';

// Notion
const notion = new Notion({ auth: process.env.NOTION_TOKEN });

// Dify
const DIFY_API_URL = process.env.DIFY_API_URL ?? 'https://api.dify.ai/v1';
const DIFY_API_KEY = process.env.DIFY_API_KEY as string;
const DIFY_DATASET_ID = process.env.DIFY_DATASET_ID as string;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  // Notion が送る JSON ボディは Next.js 側で自動パース済み
  const body = req.body as any;

  // 初回 Verification リクエストの場合、そのまま token を返すだけ
  if (body.verification_token) {
    console.log('Received Notion verification_token:', body.verification_token);
    return res.status(200).json({ verification_token: body.verification_token });
  }

  const events = body.events as any[];
  if (!Array.isArray(events)) return res.status(400).end();

  try {
    for (const ev of events) {
      if (ev.object !== 'page') continue;
      const changed = ev.changed_properties as any[];
      const approved = changed?.find((p: any) => p.property_name === '承認' || p.property_id === '承認');
      if (!approved || approved.after !== true) continue;

      const pageId = ev.id;
      const page = await notion.pages.retrieve({ page_id: pageId });
      const props: any = (page as any).properties;
      const question = props['質問']?.title?.[0]?.plain_text ?? 'Untitled';
      const answer = props['回答']?.rich_text?.[0]?.plain_text ?? '';

      await pushToDify(question, answer);
    }

    res.json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function pushToDify(question: string, answer: string) {
  if (!DIFY_API_KEY || !DIFY_DATASET_ID) return;

  await fetch(`${DIFY_API_URL}/datasets/${DIFY_DATASET_ID}/document/create_by_text`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DIFY_API_KEY}`,
    },
    body: JSON.stringify({
      name: question.slice(0, 50), // ドキュメント名を先頭 50 文字に切り詰め
      text: `${question}\n${answer}`,
      indexing_technique: 'high_quality',
      process_rule: { mode: 'automatic' },
    }),
  });
} 