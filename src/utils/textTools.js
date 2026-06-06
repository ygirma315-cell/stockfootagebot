const STOP_WORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'all',
  'also',
  'am',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'because',
  'before',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'should',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your'
]);

const VISUAL_HINTS = new Set([
  'aerial',
  'beach',
  'building',
  'business',
  'camera',
  'car',
  'city',
  'close',
  'clouds',
  'crowd',
  'desert',
  'dog',
  'drone',
  'factory',
  'family',
  'farm',
  'field',
  'forest',
  'garden',
  'hands',
  'house',
  'landscape',
  'light',
  'market',
  'mountain',
  'nature',
  'night',
  'ocean',
  'office',
  'people',
  'portrait',
  'rain',
  'river',
  'road',
  'room',
  'sea',
  'shop',
  'sky',
  'skyline',
  'street',
  'sunrise',
  'sunset',
  'technology',
  'traffic',
  'travel',
  'tree',
  'urban',
  'walking',
  'water',
  'waves',
  'woman',
  'worker'
]);

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function sanitizePrompt(text) {
  return normalizeWhitespace(
    String(text || '')
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/[<>[\]{}|\\^`~]/g, ' ')
  );
}

function wordCount(text) {
  const words = normalizeWhitespace(text).match(/[a-z0-9']+/gi);
  return words ? words.length : 0;
}

function tokenize(text) {
  return normalizeWhitespace(text)
    .toLowerCase()
    .match(/[a-z0-9']+/gi) || [];
}

function uniqueWords(words) {
  const seen = new Set();
  const result = [];

  for (const word of words) {
    const cleaned = word.replace(/^'+|'+$/g, '');
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }

    seen.add(cleaned);
    result.push(cleaned);
  }

  return result;
}

function extractVisualWords(text, limit = 8) {
  const words = tokenize(text)
    .filter((word) => word.length > 2)
    .filter((word) => !STOP_WORDS.has(word));

  const unique = uniqueWords(words);
  const visual = unique.filter((word) => VISUAL_HINTS.has(word));
  const others = unique.filter((word) => !VISUAL_HINTS.has(word));

  return [...visual, ...others].slice(0, limit);
}

function inferStyleWords(text, mediaType) {
  const lower = normalizeWhitespace(text).toLowerCase();
  const styles = [];

  if (/(sunset|sunrise|night|moody|dramatic|film|cinematic)/.test(lower)) {
    styles.push('cinematic');
  }

  if (/(nature|forest|ocean|beach|mountain|river|wildlife|field)/.test(lower)) {
    styles.push('nature');
  }

  if (/(city|urban|street|traffic|skyline|office|business)/.test(lower)) {
    styles.push('city');
  }

  if (/(person|people|man|woman|family|worker|crowd|walking)/.test(lower)) {
    styles.push('realistic');
  }

  if (mediaType === 'video' && !styles.includes('cinematic')) {
    styles.push('cinematic');
  }

  if (styles.length === 0) {
    styles.push('realistic');
  }

  return uniqueWords(styles).slice(0, 2);
}

function specialVisualQuery(text) {
  const lower = normalizeWhitespace(text).toLowerCase();
  const patterns = [
    {
      pattern: /(food|meal|grocer).*(door|deliver)|delivery.*(food|meal|door)/,
      query: 'food delivery doorstep'
    },
    {
      pattern: /(message|messages|communication).*(planet|world|seconds|instant|travel)/,
      query: 'global communication technology'
    },
    {
      pattern: /(product|products|package|packages).*(arrive|click|online|order)/,
      query: 'online shopping package delivery'
    },
    {
      pattern: /(everything|life|daily).*(easier|easy|convenient|simple)/,
      query: 'modern convenience lifestyle'
    },
    {
      pattern: /(convenience|consumer).*(hidden cost|cost|behind)/,
      query: 'consumerism hidden cost'
    },
    {
      pattern: /(factory|factories).*(night|day|run|machines|machine)/,
      query: 'factory machines night'
    },
    {
      pattern: /(worker|workers).*(rush|deadline|deadlines|stress|impossible)/,
      query: 'stressed warehouse workers'
    },
    {
      pattern: /(plastic|trash|waste).*(ocean|oceans|sea|water)/,
      query: 'plastic ocean pollution'
    },
    {
      pattern: /(city|cities|urban).*(loud|louder|fast|faster|stress|stressful|noise)/,
      query: 'busy stressful city'
    }
  ];

  return patterns.find((item) => item.pattern.test(lower))?.query || '';
}

function buildSearchQuery(text, mediaType) {
  const safe = sanitizePrompt(text);
  const specialQuery = specialVisualQuery(safe);

  if (specialQuery) {
    return `${specialQuery} ${inferStyleWords(safe, mediaType).join(' ')}`.trim();
  }

  const visualWords = extractVisualWords(safe, 7);
  const styleWords = inferStyleWords(safe, mediaType);
  const queryWords = uniqueWords([...visualWords, ...styleWords]);

  if (queryWords.length === 0) {
    return safe.slice(0, 80) || 'cinematic realistic';
  }

  return queryWords.slice(0, 10).join(' ');
}

function simplifyQuery(query) {
  const words = extractVisualWords(query, 5);
  return words.length > 0 ? words.join(' ') : normalizeWhitespace(query).slice(0, 80);
}

function splitParagraphs(text) {
  return String(text || '')
    .split(/\n\s*\n/g)
    .map(sanitizePrompt)
    .filter(Boolean);
}

function splitStrongSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?;:])\s+/g)
    .map(sanitizePrompt)
    .filter(Boolean);
}

function truncateText(text, maxLength = 180) {
  const safe = normalizeWhitespace(text);
  if (safe.length <= maxLength) {
    return safe;
  }

  const clipped = safe.slice(0, maxLength - 3);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, lastSpace > 40 ? lastSpace : clipped.length)}...`;
}

function visualScore(text) {
  const words = tokenize(text);
  const unique = uniqueWords(words);
  let score = 0;

  for (const word of unique) {
    if (VISUAL_HINTS.has(word)) {
      score += 3;
    } else if (!STOP_WORDS.has(word) && word.length > 3) {
      score += 1;
    }
  }

  if (/(look|see|visual|camera|scene|shot|show|display|view)/i.test(text)) {
    score += 2;
  }

  return score;
}

module.exports = {
  buildSearchQuery,
  extractVisualWords,
  normalizeWhitespace,
  sanitizePrompt,
  simplifyQuery,
  splitParagraphs,
  splitStrongSentences,
  truncateText,
  visualScore,
  wordCount
};
