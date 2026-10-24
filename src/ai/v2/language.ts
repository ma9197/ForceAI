/**
 * Azerbaijani or Turkish? Both are Latin-script Turkic languages, often typed without the special letters,
 * and language models drift from Azerbaijani into Turkish (far more Turkish in their training data). A
 * Turkish reply to an Azerbaijani message reads wrong to the people in the chat, so the linter checks it
 * with these markers. Deliberately conservative: only words that exist in one language and not the other
 * (as typed in chats), and a verdict only when one side clearly wins. Anything unsure is null.
 */

/** Words that are Azerbaijani and not Turkish (typed with or without the special letters). */
const AZ_WORDS = new Set([
  'yox', 'çox', 'cox', 'deyil', 'mən', 'nə', 'nədi', 'nədir', 'nəsə', 'niyə', 'xoş', 'xeyr', 'qardaş', 'qardas', 'bəli',
  'hələ', 'axı', 'axi', 'indi', 'gəl', 'gəlir', 'gedirəm', 'gedirem', 'bilirəm', 'bilirem', 'bilmirəm', 'bilmirem',
  'edirəm', 'edirem', 'eləmə', 'eləyir', 'eleyir', 'yaxşı', 'yaxsi', 'qız', 'qiz', 'oğlan', 'uşaq', 'usaq', 'baxır', 'baxir',
  'həm', 'hamı', 'hamısı', 'görürsən', 'gorursen', 'bilirsən', 'neynirsən', 'neynirsen', 'necəsən', 'necesen',
  'dünən', 'dunen', 'bəs', 'qədər', 'qeder', 'deyəsən', 'deyesen', 'gəlirəm', 'gelirem', 'hardasan', 'nağayrırsan',
]);
/** Words that are Turkish and not Azerbaijani. */
const TR_WORDS = new Set([
  'değil', 'degil', 'yok', 'çok', 'cok', 'ben', 'şey', 'sey', 'hoş', 'nasıl', 'nasil', 'hayır', 'hayir', 'evet', 'şimdi', 'simdi',
  'abi', 'kanka', 'neden', 'herkes', 'yarın', 'yarin', 'gibi', 'kadar', 'bence', 'aynen', 'mısın', 'misin', 'musun',
  'müsün', 'mısınız', 'misiniz', 'değilim', 'degilim', 'öyle', 'oyle', 'böyle', 'boyle', 'birşey', 'bişey', 'bisey',
]);
/** Common English words: a mostly English line is neither. */
const EN_WORDS = new Set([
  'the', 'and', 'is', 'are', 'you', 'what', 'this', 'that', 'of', 'to', 'in', 'it', 'my', 'for', 'with', 'was', 'he', 'she',
  'we', 'they', 'not', 'but', 'just', 'so', 'bro', 'lol', 'his', 'her', 'who', 'how', 'why', 'when', 'be', 'have', 'will', 'can',
]);

/** Turkish present-continuous ("geliyorum", "yapıyor"): the clearest Turkish suffix, absent from Azerbaijani. */
const TR_YOR = /^\p{L}+(?:ı|i|u|ü)yor(?:um|sun|uz|sunuz|lar|du|dum|muş|mus)?$/u;
/** Azerbaijani present tense, first person ("gedirəm", "gəlirik"); Turkish says "gidiyorum", "geliyoruz". */
const AZ_IR = /^\p{L}{2,}(?:ır|ir|ur|ür)(?:am|əm|em|ıq|ik|uq|ük)$/u;

/** 'az' or 'tr' when the markers clearly point one way (2+ points ahead), else null. */
export function azOrTr(text: string): 'az' | 'tr' | null {
  const words = text.toLocaleLowerCase('tr').match(/\p{L}+/gu) ?? [];
  if (words.length < 2) return null;
  if (words.filter(w => EN_WORDS.has(w)).length / words.length >= 0.3) return null;
  let az = 0;
  let tr = 0;
  for (const w of words) {
    if (w.includes('ə') || AZ_WORDS.has(w)) az += 2;
    else if (AZ_IR.test(w)) az += 1;
    if (TR_WORDS.has(w) || TR_YOR.test(w)) tr += 2;
  }
  if (az - tr >= 2) return 'az';
  if (tr - az >= 2) return 'tr';
  return null;
}
