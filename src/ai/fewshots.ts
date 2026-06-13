import fs from 'node:fs';
import { TRAINING_DATA_PATH } from '../config.js';
import { logger } from '../logger.js';

interface Exchange {
  num: number;
  trigger: string[];
  ai: string[];
  notes: string | null;
}

/** Exchanges that best demonstrate stacking, multi-person handling, steering, refusals, meta-awareness. */
const PRIORITY = [6, 11, 13, 14, 15, 16, 19, 22, 23, 24, 25, 26, 27, 28, 31, 33, 36, 39];

function parseTrainingFile(content: string): { exchanges: Exchange[]; profile: string } {
  const exchanges: Exchange[] = [];
  const exchangeRe = /--- EXCHANGE (\d+) ---\n([\s\S]*?)(?=--- EXCHANGE \d+ ---|====)/g;

  let match: RegExpExecArray | null;
  while ((match = exchangeRe.exec(content)) !== null) {
    const num = Number(match[1]);
    const body = match[2];
    const trigger: string[] = [];
    const ai: string[] = [];
    let notes: string | null = null;
    let mode: 'trigger' | 'ai' | 'notes' | null = null;
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (t === '[TRIGGER]') { mode = 'trigger'; continue; }
      if (t === '[AI]') { mode = 'ai'; continue; }
      if (t.startsWith('[NOTES]')) { mode = 'notes'; notes = t.replace('[NOTES]', '').trim(); continue; }
      if (!t) continue;
      if (mode === 'trigger') trigger.push(t);
      else if (mode === 'ai') ai.push(t);
      else if (mode === 'notes' && notes !== null) notes += ' ' + t;
    }
    if (trigger.length && ai.length) exchanges.push({ num, trigger, ai, notes });
  }

  const profileMatch = content.match(/PERSONALITY PROFILE SUMMARY\n=+\n([\s\S]*)$/);
  const profile = profileMatch ? profileMatch[1].trim() : '';
  return { exchanges, profile };
}

export interface TrainingData {
  fewshotBlock: string;
  profileBlock: string;
}

export function loadTrainingData(): TrainingData {
  let content = '';
  try {
    content = fs.readFileSync(TRAINING_DATA_PATH, 'utf-8');
  } catch (err) {
    logger.warn({ err }, 'training data file missing — persona will use defaults only');
    return { fewshotBlock: '', profileBlock: '' };
  }

  const { exchanges, profile } = parseTrainingFile(content);
  const selected = exchanges.filter(e => PRIORITY.includes(e.num));

  const fewshotBlock = selected.map(e => {
    const lines = [
      `<example>`,
      `[CHAT]`,
      ...e.trigger,
      `[YOU]`,
      ...e.ai,
    ];
    if (e.notes) lines.push(`[WHY] ${e.notes}`);
    lines.push(`</example>`);
    return lines.join('\n');
  }).join('\n\n');

  return { fewshotBlock, profileBlock: profile };
}
