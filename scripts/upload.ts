/**
 * scripts/upload.ts
 * formatted_output.md → OpenAI → Notion へ登録
 * 実行:  npm run upload
 */

import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';
import { Client as Notion } from '@notionhq/client';
import OpenAI from 'openai';

config();

const { OPENAI_API_KEY, NOTION_TOKEN, NOTION_DB_ID } = process.env;
if (!OPENAI_API_KEY || !NOTION_TOKEN || !NOTION_DB_ID) {
  throw new Error('OPENAI_API_KEY / NOTION_TOKEN / NOTION_DB_ID を .env に設定してください');
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const notion = new Notion({ auth: NOTION_TOKEN });

const MD_PATH = path.join(process.cwd(), 'formatted_output.md');
const DONE_JSON = path.join(process.cwd(), '.done.json');
const RATE_MS = 1100; // 1.1 秒

interface Item {
  question: string;
  answer: string;
  dialog: string;
}

function parseMarkdown(md: string): Item[] {
  const sections = md.trim().split(/\r?\n\s*\r?\n/);
  return sections.map(section => {
    const lines = section.split(/\n/);
    const question = lines[0].split(':')[1].trim();
    const answer = lines[1].replace('回答:', '').trim();
    const dialog = lines.slice(2).join('\n');
    return { question, answer, dialog };
  });
}

function loadDone(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(DONE_JSON, 'utf8')));
  } catch {
    return new Set();
  }
}

function saveDone(done: Set<string>) {
  fs.writeFileSync(DONE_JSON, JSON.stringify(Array.from(done), null, 2));
}

async function genAnswer(question: string, context: string): Promise<string> {
  const prompt = `あなたはPremiere Pro公式サポートBotです。\n` +
    `以下の「質問」と「回答+やりとり」を参考に、` +
    `同じトーン（丁寧語＋適度な絵文字）で、分かりやすい回答文を1つ作成してください。\n\n` +
    `### 質問\n${question}\n\n` +
    `### 回答＋やりとり\n${context}\n\n` +
    `### 出力\n{answer}`;

  const chat = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: prompt }]
  });
  return chat.choices[0].message?.content?.trim() ?? '';
}

async function sendNotion(question: string, answer: string) {
  await notion.pages.create({
    parent: { database_id: NOTION_DB_ID as string },
    properties: {
      '質問': {
        title: [{ text: { content: question } }]
      },
      '回答': {
        rich_text: [{ text: { content: answer } }]
      }
    }
  });
}

async function main() {
  if (!fs.existsSync(MD_PATH)) {
    throw new Error(`${MD_PATH} が見つかりません`);
  }

  const md = fs.readFileSync(MD_PATH, 'utf8');
  const items = parseMarkdown(md);
  const done = loadDone();

  for (let i = 0; i < items.length; i++) {
    const { question, answer, dialog } = items[i];
    if (done.has(question)) {
      console.log(`[${i + 1}] skip`);
      continue;
    }
    try {
      const newAns = await genAnswer(question, answer + '\n' + dialog);
      await sendNotion(question, newAns);
      done.add(question);
      saveDone(done);
      console.log(`[${i + 1}] ✅ 登録`);
      await new Promise(res => setTimeout(res, RATE_MS));
    } catch (e) {
      console.error(`[${i + 1}] ❌`, e);
      break;
    }
  }
}

main().catch(console.error); 