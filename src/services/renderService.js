const fs = require('fs/promises');
const { spawn } = require('child_process');
const ffmpeg = require('@ffmpeg-installer/ffmpeg');
const config = require('../config');
const logger = require('../utils/logger');
const { cleanupFile, tempFilePath } = require('../utils/fileCleanup');
const { downloadVideo, searchVideos } = require('./pexelsService');
const { estimateVoiceDuration, synthesizeVoiceover } = require('./voiceoverService');
const {
  normalizeWhitespace,
  sanitizePrompt,
  splitStrongSentences,
  truncateText,
  wordCount
} = require('../utils/textTools');

const ffmpegPath = ffmpeg.path;

function dimensionsForRatio(ratioLabel) {
  if (ratioLabel === '9:16') {
    return {
      height: 1280,
      width: 720
    };
  }

  return {
    height: 720,
    width: 1280
  };
}

function voiceoverTextFromScript(script) {
  const cleanScript = String(script || '').trim();
  const voiceoverMatch = cleanScript.match(/voice[-\s]?over\s*:\s*([\s\S]+)/i);
  const captionSplit = voiceoverMatch?.[1]?.split(/\n\s*(?:caption|captions|scene)\b\s*:?\s*/i)[0];
  const text = captionSplit || cleanScript;

  return sanitizePrompt(text).slice(0, config.voiceoverMaxChars);
}

function selectScenes(scenes) {
  return (Array.isArray(scenes) ? scenes : [])
    .filter((scene) => normalizeWhitespace(scene.description || scene.pexelsQuery))
    .slice(0, config.renderMaxScenes);
}

function distributeDurations(totalDuration, scenes, options = {}) {
  const count = Math.max(scenes.length, 1);
  const safeTotal = Math.max(totalDuration, 1);
  const minDuration = options.matchTotalDuration
    ? Math.max(0.05, (safeTotal / count) * 0.45)
    : 2.5;
  const weights = scenes.map((scene) =>
    Math.max(4, wordCount(`${scene.description || ''} ${scene.pexelsQuery || ''}`))
  );
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || count;
  const remaining = Math.max(0, safeTotal - minDuration * count);

  return weights.map((weight) => minDuration + remaining * (weight / totalWeight));
}

function wrapCaption(text, maxLineLength = 34) {
  const words = normalizeWhitespace(text).split(' ').filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxLineLength) {
      line = next;
      continue;
    }

    if (line) {
      lines.push(line);
    }
    line = word;
  }

  if (line) {
    lines.push(line);
  }

  return lines.slice(0, 2).join('\\n');
}

function escapeDrawText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,');
}

function sceneCaption(scene) {
  const description = scene.description || scene.pexelsQuery || 'Cinematic scene';
  return wrapCaption(truncateText(description, 96));
}

function buildFilter({ scenes, durations, dimensions, burnCaptions }) {
  const filters = scenes.map((scene, index) => {
    const duration = durations[index].toFixed(2);
    return [
      `[${index}:v]scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=increase`,
      `crop=${dimensions.width}:${dimensions.height}`,
      'setsar=1',
      'fps=24',
      `trim=duration=${duration}`,
      `setpts=PTS-STARTPTS[v${index}]`
    ].join(',');
  });

  if (scenes.length === 1) {
    filters.push('[v0]null[base]');
  } else {
    filters.push(
      `${scenes.map((scene, index) => `[v${index}]`).join('')}concat=n=${scenes.length}:v=1:a=0[base]`
    );
  }

  if (!burnCaptions) {
    return {
      outputLabel: 'base',
      value: filters.join(';')
    };
  }

  let start = 0;
  let inputLabel = 'base';

  for (let index = 0; index < scenes.length; index += 1) {
    const end = start + durations[index];
    const outputLabel = `cap${index}`;
    const fontSize = dimensions.width >= 1000 ? 42 : 34;
    const boxBorder = dimensions.width >= 1000 ? 20 : 16;
    const y = Math.round(dimensions.height * 0.76);
    const caption = escapeDrawText(sceneCaption(scenes[index]));

    filters.push(
      [
        `[${inputLabel}]drawtext=`,
        `text='${caption}'`,
        `:fontcolor=white`,
        `:fontsize=${fontSize}`,
        `:box=1`,
        `:boxcolor=black@0.58`,
        `:boxborderw=${boxBorder}`,
        `:x=(w-text_w)/2`,
        `:y=${y}`,
        `:enable='between(t\\,${start.toFixed(2)}\\,${end.toFixed(2)})'`,
        `[${outputLabel}]`
      ].join('')
    );

    inputLabel = outputLabel;
    start = end;
  }

  return {
    outputLabel: inputLabel,
    value: filters.join(';')
  };
}

function renderArgs({ audioPath, clips, dimensions, durations, outputPath, scenes, burnCaptions }) {
  const args = ['-y', '-hide_banner'];

  for (const clip of clips) {
    args.push('-stream_loop', '-1', '-i', clip.path);
  }

  if (audioPath) {
    args.push('-i', audioPath);
  }

  const filter = buildFilter({
    burnCaptions,
    dimensions,
    durations,
    scenes
  });

  args.push('-filter_complex', filter.value, '-map', `[${filter.outputLabel}]`);

  if (audioPath) {
    args.push('-map', `${clips.length}:a:0`, '-shortest');
  }

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    dimensions.width >= 1000 ? '30' : '31',
    '-pix_fmt',
    'yuv420p'
  );

  if (audioPath) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  }

  args.push('-movflags', '+faststart', outputPath);
  return args;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Video render timed out.'));
    }, config.renderTimeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-5000);
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Video render failed with ffmpeg code ${code}: ${stderr}`));
    });
  });
}

async function findAndDownloadClip(scene, orientation, excludeIds) {
  const searchTerms = [
    scene.pexelsQuery,
    simplifySceneQuery(scene),
    orientation === 'portrait' ? 'vertical cinematic lifestyle' : 'cinematic lifestyle'
  ].filter(Boolean);

  for (const query of searchTerms) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await searchVideos(query, {
        excludeIds,
        orientation
      });

      if (!result) {
        break;
      }

      excludeIds.push(result.id);

      try {
        return {
          path: await downloadVideo(result, {
            maxBytes: config.renderClipMaxBytes
          }),
          query,
          result
        };
      } catch (error) {
        logger.warn('Render clip candidate download failed.', {
          error: {
            name: error.name,
            message: error.message
          },
          query
        });
      }
    }
  }

  return null;
}

function simplifySceneQuery(scene) {
  const text = normalizeWhitespace(`${scene.description || ''} ${scene.pexelsQuery || ''}`);
  const words = text
    .toLowerCase()
    .match(/[a-z0-9']+/g) || [];
  return words
    .filter((word) => word.length > 3)
    .slice(0, 5)
    .join(' ');
}

function estimateRenderDuration(script, sceneCount) {
  const textDuration = estimateVoiceDuration(script);
  return Math.max(sceneCount * 3.5, Math.min(textDuration, 60));
}

async function renderFile({
  audioPath,
  clips,
  dimensions,
  durations,
  outputPath,
  scenes
}) {
  try {
    await runFfmpeg(
      renderArgs({
        audioPath,
        burnCaptions: true,
        clips,
        dimensions,
        durations,
        outputPath,
        scenes
      })
    );

    return true;
  } catch (error) {
    logger.warn('Captioned render failed, retrying without burned captions.', {
      error: {
        name: error.name,
        message: error.message
      }
    });
    await cleanupFile(outputPath).catch(() => {});
    await runFfmpeg(
      renderArgs({
        audioPath,
        burnCaptions: false,
        clips,
        dimensions,
        durations,
        outputPath,
        scenes
      })
    );

    return false;
  }
}

async function renderPremiumVideo({
  analysis,
  onProgress,
  ratioLabel,
  script,
  voiceover
}) {
  const cleanupPaths = [];
  try {
    const scenes = selectScenes(analysis?.scenes);

    if (scenes.length === 0) {
      throw new Error('No visual scenes were found for rendering.');
    }

    const progress = async (percent, message) => {
      if (typeof onProgress === 'function') {
        await onProgress({
          message,
          percent
        });
      }
    };
    const dimensions = dimensionsForRatio(ratioLabel);
    const orientation = ratioLabel === '9:16' ? 'portrait' : 'landscape';
    const voiceText = voiceoverTextFromScript(script);
    let voice = null;

    if (voiceover?.source !== 'none') {
      await progress(30, 'Generating voice-over audio');
      voice = await synthesizeVoiceover(voiceText, voiceover);
      cleanupPaths.push(voice.path);
    }

    await progress(voice ? 40 : 30, `Finding and downloading clips 0/${scenes.length}`);
    const excludeIds = [];
    const clips = [];

    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index];
      try {
        const clip = await findAndDownloadClip(scene, orientation, excludeIds);
        if (clip) {
          clips.push({
            ...clip,
            scene
          });
          cleanupPaths.push(clip.path);
        }
      } catch (error) {
        logger.warn('Render clip download skipped.', {
          error: {
            name: error.name,
            message: error.message
          },
          scene: scene.sceneNumber
        });
      }

      const downloadStart = voice ? 40 : 30;
      const downloadRange = voice ? 25 : 35;
      const percent = Math.min(65, downloadStart + Math.round(((index + 1) / scenes.length) * downloadRange));
      await progress(
        percent,
        `Finding and downloading clips ${index + 1}/${scenes.length}`
      );
    }

    if (clips.length === 0) {
      throw new Error('No downloadable footage was found for this script.');
    }

    const renderedScenes = clips.map((clip) => clip.scene);
    const totalDuration = voice?.duration || estimateRenderDuration(voiceText, renderedScenes.length);
    const durations = distributeDurations(totalDuration, renderedScenes, {
      matchTotalDuration: Boolean(voice)
    });
    const outputPath = tempFilePath('premium-render', '.mp4');
    cleanupPaths.push(outputPath);

    await progress(72, 'Trimming clips and arranging scenes');
    await progress(82, 'Rendering captions, edits, and audio');
    const captionsBurned = await renderFile({
      audioPath: voice?.path || '',
      clips,
      dimensions,
      durations,
      outputPath,
      scenes: renderedScenes
    });

    const stat = await fs.stat(outputPath);
    await progress(90, 'Checking the finished video');

    if (stat.size > config.telegramVideoMaxBytes) {
      throw new Error('Rendered video is too large for Telegram upload. Try a shorter script.');
    }

    return {
      audioUsed: Boolean(voice),
      captionsBurned,
      cleanupPaths,
      duration: durations.reduce((sum, value) => sum + value, 0),
      outputPath,
      sceneCount: renderedScenes.length,
      sizeBytes: stat.size
    };
  } catch (error) {
    await Promise.all(cleanupPaths.map((filePath) => cleanupFile(filePath).catch(() => {})));
    throw error;
  }
}

module.exports = {
  renderPremiumVideo
};
