import type { BotAction } from '../../types.js';

/** One action as a readable line for the dashboard (Compare panel, shadow "would say" rows). */
export function describeAction(a: BotAction): string {
  switch (a.type) {
    case 'message': return a.text;
    case 'reply': return `↩ #${a.target_message_id}: ${a.text}`;
    case 'reaction': return `reacts ${a.emoji} on #${a.target_message_id}`;
    case 'sticker': return `[sticker ${a.sticker_id}]`;
    case 'poll': return `[poll] ${a.question} (${a.options.join(' / ')})`;
    case 'voice': return `🎤 ${a.text}`;
    case 'image': return `🖼 ${a.prompt}${a.caption ? ` / caption: ${a.caption}` : ''}`;
    case 'sleep': return '(goes to sleep)';
    default: return '(stays silent)';
  }
}
