const config = require('../config');
const { analyzeWithAi } = require('./aiService');
const {
  buildSearchQuery,
  normalizeWhitespace,
  sanitizePrompt,
  splitParagraphs,
  splitStrongSentences,
  truncateText,
  visualScore,
  wordCount
} = require('../utils/textTools');

function classifyText(text) {
  const words = wordCount(text);

  if (words <= 20) {
    return 'short';
  }

  if (words <= 120) {
    return 'medium';
  }

  return 'long';
}

function targetSceneCount(textType, words, maxScenes) {
  if (textType === 'short') {
    return 1;
  }

  if (textType === 'medium') {
    return Math.min(maxScenes, Math.max(3, Math.ceil(words / 6)));
  }

  return Math.min(maxScenes, Math.max(5, Math.ceil(words / 28)));
}

function groupSentences(sentences, targetCount) {
  if (sentences.length <= targetCount) {
    return sentences;
  }

  const groupSize = Math.ceil(sentences.length / targetCount);
  const groups = [];

  for (let index = 0; index < sentences.length; index += groupSize) {
    groups.push(sentences.slice(index, index + groupSize).join(' '));
  }

  return groups;
}

function splitSceneBlocks(text) {
  return String(text || '')
    .split(/(?=\b(?:scene|shot|clip|part)\s*\d+\s*[:.-])/gi)
    .map(sanitizePrompt)
    .filter((segment) => wordCount(segment) >= 3);
}

function stripNarrationSections(text) {
  const rawText = String(text || '');
  const visualText = rawText.replace(
    /\n\s*(?:voice[-\s]?over|caption lines?|captions)\s*:[\s\S]*$/i,
    ''
  );

  return wordCount(visualText) >= 3 ? visualText : rawText;
}

function chooseCandidateSegments(text, textType, targetCount) {
  const sceneBlocks = splitSceneBlocks(text);

  if (sceneBlocks.length >= 2) {
    return sceneBlocks;
  }

  const paragraphs = splitParagraphs(text);

  if (textType === 'medium' && paragraphs.length >= 2) {
    return paragraphs;
  }

  if (textType === 'long' && paragraphs.length >= targetCount) {
    return paragraphs;
  }

  const sentences = splitStrongSentences(text);
  if (sentences.length > 1) {
    return groupSentences(sentences, targetCount * 2);
  }

  return paragraphs.length > 0 ? paragraphs : [sanitizePrompt(text)];
}

function pickUsefulSegments(segments, targetCount, textType) {
  if (segments.length <= targetCount) {
    return segments;
  }

  if (textType === 'medium') {
    return segments
      .map((segment, index) => ({
        segment,
        index,
        score: visualScore(segment)
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, targetCount)
      .sort((a, b) => a.index - b.index)
      .map((item) => item.segment);
  }

  return segments
    .map((segment, index) => ({
      segment,
      index,
      score: visualScore(segment)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, targetCount)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.segment);
}

function localAnalyze(text, mediaType, maxScenes) {
  const safeText = sanitizePrompt(text);
  const words = wordCount(safeText);
  const textType = classifyText(safeText);
  const explicitSceneCount = splitSceneBlocks(safeText).length;
  const targetCount = Math.min(
    maxScenes,
    Math.max(targetSceneCount(textType, words, maxScenes), explicitSceneCount)
  );

  if (textType === 'short') {
    return {
      mediaCount: 1,
      scenes: [
        {
          sceneNumber: 1,
          description: truncateText(safeText, 180),
          pexelsQuery: buildSearchQuery(safeText, mediaType)
        }
      ],
      truncated: false,
      source: 'local'
    };
  }

  const candidates = chooseCandidateSegments(safeText, textType, targetCount);
  const pickedSegments = pickUsefulSegments(candidates, targetCount, textType).slice(0, maxScenes);

  const scenes = pickedSegments.map((segment, index) => ({
    sceneNumber: index + 1,
    description: truncateText(segment, 180),
    pexelsQuery: buildSearchQuery(segment, mediaType)
  }));

  return {
    mediaCount: scenes.length,
    scenes,
    truncated: candidates.length > scenes.length || targetCount > scenes.length,
    source: 'local'
  };
}

async function analyzeScript(text, mediaType, options = {}) {
  const safeText = sanitizePrompt(stripNarrationSections(text));

  if (!safeText) {
    throw new Error('Prompt is empty.');
  }

  const textType = classifyText(safeText);
  const maxScenes = options.maxScenes || config.maxMediaPerRequest;

  if (textType !== 'short') {
    const aiResult = await analyzeWithAi(safeText, mediaType, maxScenes);
    if (aiResult && aiResult.scenes.length >= 2) {
      return {
        ...aiResult,
        textType,
        truncated: Boolean(aiResult.truncated)
      };
    }
  }

  return {
    ...localAnalyze(safeText, mediaType, maxScenes),
    textType
  };
}

module.exports = {
  analyzeScript,
  classifyText
};
