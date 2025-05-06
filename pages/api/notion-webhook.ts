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

  // デバッグ用: 受信ボディをそのまま出力（機密情報が含まれる場合は削除を検討）
  console.log('Notion webhook body:', JSON.stringify(body));

  // 初回 Verification リクエストの場合、そのまま token を返すだけ
  if (body.verification_token) {
    console.log('Received Notion verification_token:', body.verification_token);
    return res.status(200).json({ verification_token: body.verification_token });
  }

  // Notion 公式 Webhook の challenge 方式 (beta) にも対応
  if (body.challenge) {
    console.log('Received Notion challenge:', body.challenge);
    return res.status(200).json({ challenge: body.challenge });
  }

  const events = body.events as any[];
  if (!Array.isArray(events)) return res.status(400).end();

  // 対象とするイベントタイプ（ノイズ削減用）
  const VALID_TYPES = [
    'page.created',
    'page.updated',
    'page.property_value_changed', // Notion beta (individualプロパティ)
    'page.properties_updated',    // 旧表記
    'page.content_updated',       // 🔥 UI 上は「Page content updated」
  ];

  try {
    for (const ev of events) {
      // page オブジェクト以外は無視
      if (ev.object !== 'page') continue;
      if (!VALID_TYPES.includes(ev.type)) {
        console.log('Ignored event type:', ev.type);
        continue;
      }

      const pageId: string | undefined = ev.id || ev.page_id || ev.entity_id;
      if (!pageId) continue;

      // 最新のページ情報を取得し、承認チェックボックスの実際の値で判定
      const page = await notion.pages.retrieve({ page_id: pageId });
      const props: any = (page as any).properties;

      const APPROVAL_NAME = '承認';
      const APPROVAL_ID = process.env.APPROVAL_PROPERTY_ID; // 任意

      const approved = Object.entries(props).some(([name, prop]: any) => {
        if (prop.type !== 'checkbox') return false;
        if (name === APPROVAL_NAME) return prop.checkbox === true;
        if (APPROVAL_ID && prop.id === APPROVAL_ID) return prop.checkbox === true;
        return false;
      });

      if (!approved) continue;

      console.log(`Approved page detected: ${pageId}`);

      const question = props['質問']?.title?.[0]?.plain_text ?? 'Untitled';
      const answer = props['回答']?.rich_text?.[0]?.plain_text ?? '';

      await pushToDify(question, answer);
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
      'Authorization': `Bearer ${DIFY_API_KEY}`,
    },
    body: JSON.stringify({
      name: question.slice(0, 50), // ドキュメント名を先頭 50 文字に切り詰め
      text: `${question}\n${answer}`,
      indexing_technique: 'high_quality',
      process_rule: { mode: 'automatic' },
    }),
  }).then(res => {
    if (!res.ok) {
      console.error('Dify API error', res.status, res.statusText);
    }
  }).catch(err => console.error('Dify fetch error', err));
} 