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

  // Notion が送る JSON ボディは Vercel で自動パース済み
  const body = req.body as any;

  // 初回 Verification
  if (body.verification_token) {
    // デバッグ用: Verification Token をログに出力（本番では削除推奨）
    console.log('Notion verification_token:', body.verification_token);
    return res.status(200).json({ verification_token: body.verification_token });
  }
  // beta challenge
  if (body.challenge) {
    return res.status(200).json({ challenge: body.challenge });
  }

  const events: any[] = Array.isArray(body)
    ? body
    : Array.isArray(body.events)
    ? body.events
    : [body];

  // 監視対象のイベントタイプを "page.properties_updated" のみに限定
  const VALID_TYPES = ['page.properties_updated'];

  try {
    for (const ev of events) {
      console.log('Received event:', ev.type, ev.id ?? ev.page_id ?? ev.entity?.id);
      if (ev.object !== 'page') continue;
      if (!VALID_TYPES.includes(ev.type)) continue;

      const pageId: string | undefined = ev.id || ev.page_id || ev.entity?.id;
      if (!pageId) continue;

      const page = await notion.pages.retrieve({ page_id: pageId });
      const props: any = (page as any).properties;

      // デバッグ: ページID と主要プロパティ状態を出力
      console.log('[DEBUG] Page:', pageId);
      console.log('[DEBUG] 承認 checkbox value:', props['承認']?.checkbox);
      console.log('[DEBUG] 質問 exists:', !!props['質問']);
      console.log('[DEBUG] 回答 exists:', !!props['回答']);

      // Approval check
      const approved = props['承認']?.type === 'checkbox' && props['承認'].checkbox === true;
      if (!approved) continue;

      console.log('[DEBUG] Approved page detected:', pageId);

      const question = props['質問']?.title?.[0]?.plain_text ?? 'Untitled';
      const answer = props['回答']?.rich_text?.[0]?.plain_text ?? '';

      console.log('[DEBUG] Sending to Dify:', { question, answer });
      await pushToDify(question, answer);
      console.log('[DEBUG] Dify push done');
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function pushToDify(question: string, answer: string) {
  if (!DIFY_API_KEY || !DIFY_DATASET_ID) return;

  await fetch(`${DIFY_API_URL}/datasets/${DIFY_DATASET_ID}/document/create_by_text`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DIFY_API_KEY}`,
    },
    body: JSON.stringify({
      name: question.slice(0, 50),
      text: `${question}\n${answer}`,
      indexing_technique: 'high_quality',
      process_rule: { mode: 'automatic' },
    }),
  }).then((r) => {
    if (!r.ok) console.error('Dify API error', r.status);
  });
} 