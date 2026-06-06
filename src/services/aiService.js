const config = require('../config');
const logger = require('../utils/logger');
const {
  buildSearchQuery,
  normalizeWhitespace,
  sanitizePrompt,
  truncateText
} = require('../utils/textTools');

function stripJsonFence(content) {
  return String(content || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function validateAiScenes(payload, mediaType, maxScenes) {
  if (!payload || !Array.isArray(payload.scenes)) {
    return null;
  }

  const scenes = payload.scenes
    .map((scene, index) => {
      const description = sanitizePrompt(scene.description || scene.scene || scene.text || '');
      const pexelsQuery = sanitizePrompt(
        scene.pexels_query || scene.pexelsQuery || scene.query || description
      );

      if (!description && !pexelsQuery) {
        return null;
      }

      return {
        sceneNumber: index + 1,
        description: truncateText(description || pexelsQuery, 180),
        pexelsQuery: buildSearchQuery(pexelsQuery || description, mediaType)
      };
    })
    .filter(Boolean)
    .slice(0, maxScenes);

  if (scenes.length === 0) {
    return null;
  }

  return {
    mediaCount: scenes.length,
    scenes,
    truncated:
      Number.isFinite(payload.media_count) && Number(payload.media_count) > scenes.length,
    source: 'ai'
  };
}

async function analyzeWithAi(text, mediaType, maxScenes) {
  if (!config.aiApiKey) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  const systemPrompt = [
    'You convert user scripts into Pexels media search scenes.',
    'Return JSON only. No markdown. No commentary.',
    'Do not split short prompts. Preserve meaning.',
    'For scripts, decide the scene count from the context instead of always returning one scene.',
    'Each pexels_query must be a short visual tag phrase for Pexels, searchable, and in English.'
  ].join(' ');

  const userPrompt = JSON.stringify({
    task: `Create ${mediaType} search scenes for Pexels.`,
    max_scenes: maxScenes,
    rules: [
      'Short prompt under about 20 words = exactly one scene.',
      'Medium script = 3 to 16 scenes when there are enough distinct visual ideas.',
      'Long script = up to max_scenes scenes.',
      'Use one scene for each distinct visual beat when it helps the final video.',
      'Extract the most visual scenes only.',
      'Make every pexels_query short tags, usually 2 to 5 words, such as "factory workers night" or "plastic ocean waves".',
      'Return JSON in this exact shape.'
    ],
    response_format: {
      media_count: 3,
      scenes: [
        {
          scene_number: 1,
          description: 'A dog walking during sunset',
          pexels_query: 'dog sunset cinematic'
        }
      ]
    },
    input: normalizeWhitespace(text)
  });

  try {
    const response = await fetch(config.aiApiBaseUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.aiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.aiModel,
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      throw new Error('Smart scene analysis request failed.');
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(stripJsonFence(content));
    return validateAiScenes(parsed, mediaType, maxScenes);
  } catch (error) {
    logger.warn('Smart scene analysis failed, using local fallback.', {
      error: {
        name: error.name
      }
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  analyzeWithAi
};
