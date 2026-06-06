const fs = require('fs/promises');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const config = require('../config');
const logger = require('../utils/logger');
const { tempFilePath } = require('../utils/fileCleanup');
const {
  normalizeWhitespace,
  sanitizePrompt,
  splitStrongSentences,
  truncateText,
  wordCount
} = require('../utils/textTools');

const PROTO_ROOT = path.join(__dirname, '..', 'proto');
const TTS_PROTO = path.join(PROTO_ROOT, 'riva', 'proto', 'riva_tts.proto');
const MAX_CHUNK_CHARS = 340;

let rivaClient;

function getRivaClient() {
  if (rivaClient) {
    return rivaClient;
  }

  const packageDefinition = protoLoader.loadSync(TTS_PROTO, {
    defaults: true,
    enums: String,
    includeDirs: [PROTO_ROOT],
    longs: String,
    oneofs: true
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition);
  const service = loaded?.nvidia?.riva?.tts?.RivaSpeechSynthesis;

  if (!service) {
    throw new Error('Riva TTS service could not be loaded.');
  }

  rivaClient = new service(
    config.voiceoverGrpcServer,
    grpc.credentials.createSsl()
  );
  return rivaClient;
}

function ttsMetadata() {
  const metadata = new grpc.Metadata();
  metadata.add('authorization', `Bearer ${config.voiceoverApiKey}`);
  metadata.add('function-id', config.voiceoverFunctionId);
  return metadata;
}

function voiceNameFor(voiceover = {}) {
  if (voiceover.source !== 'custom') {
    return config.voiceoverModel;
  }

  const isMale = voiceover.gender === 'male';
  const emotion = voiceover.emotion || 'professional';

  if (isMale && emotion === 'energetic') {
    return 'Magpie-Multilingual.EN-US.Leo';
  }

  if (isMale) {
    return 'Magpie-Multilingual.EN-US.Jason';
  }

  if (emotion === 'calm' || emotion === 'professional') {
    return 'Magpie-Multilingual.EN-US.Sofia';
  }

  return 'Magpie-Multilingual.EN-US.Aria';
}

function splitOversizedSentence(sentence) {
  const parts = [];
  let remaining = normalizeWhitespace(sentence);

  while (remaining.length > MAX_CHUNK_CHARS) {
    const slice = remaining.slice(0, MAX_CHUNK_CHARS);
    const lastSpace = slice.lastIndexOf(' ');
    const cutAt = lastSpace > 120 ? lastSpace : MAX_CHUNK_CHARS;
    parts.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}

function splitVoiceoverChunks(text) {
  const sentences = splitStrongSentences(text);
  const units = sentences.length > 0 ? sentences : [text];
  const chunks = [];
  let current = '';

  for (const unit of units.flatMap(splitOversizedSentence)) {
    if (!unit) {
      continue;
    }

    const next = current ? `${current} ${unit}` : unit;
    if (next.length <= MAX_CHUNK_CHARS) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
    }
    current = unit;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.slice(0, config.voiceoverMaxChunks);
}

function makeWavBuffer(pcmBuffer, sampleRateHz) {
  const header = Buffer.alloc(44);
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRateHz * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function synthesizeChunk(client, text, voiceName) {
  const deadline = new Date(Date.now() + 45_000);
  const request = {
    text,
    languageCode: config.voiceoverLanguageCode,
    encoding: 'LINEAR_PCM',
    sampleRateHz: config.voiceoverSampleRateHz,
    voiceName
  };

  return new Promise((resolve, reject) => {
    client.Synthesize(request, ttsMetadata(), { deadline }, (error, response) => {
      if (error) {
        reject(error);
        return;
      }

      const audio = Buffer.from(response?.audio || []);
      if (audio.length === 0) {
        reject(new Error('Voice-over service returned empty audio.'));
        return;
      }

      resolve(audio);
    });
  });
}

async function synthesizeChunks(client, chunks, voiceName) {
  const audioBuffers = [];

  for (const chunk of chunks) {
    audioBuffers.push(await synthesizeChunk(client, chunk, voiceName));
  }

  return Buffer.concat(audioBuffers);
}

function estimateVoiceDuration(text) {
  const words = wordCount(text);
  return Math.max(4, Math.min(75, words / 2.45));
}

async function synthesizeVoiceover(text, voiceover = {}) {
  const cleanText = sanitizePrompt(text);

  if (voiceover.source === 'none') {
    return null;
  }

  if (!config.voiceoverApiKey) {
    throw new Error('Voice-over API key is missing.');
  }

  if (!cleanText) {
    throw new Error('Voice-over text is empty.');
  }

  const chunks = splitVoiceoverChunks(cleanText);
  const client = getRivaClient();
  const preferredVoice = voiceNameFor(voiceover);
  let pcmAudio;
  let voiceName = preferredVoice;

  try {
    pcmAudio = await synthesizeChunks(client, chunks, preferredVoice);
  } catch (error) {
    if (preferredVoice === config.voiceoverModel) {
      throw error;
    }

    logger.warn('Custom voice failed, retrying default voice.', {
      error: {
        name: error.name,
        message: error.message
      },
      preferredVoice
    });
    voiceName = config.voiceoverModel;
    pcmAudio = await synthesizeChunks(client, chunks, config.voiceoverModel);
  }

  const outputPath = tempFilePath('voiceover', '.wav');
  await fs.writeFile(outputPath, makeWavBuffer(pcmAudio, config.voiceoverSampleRateHz));

  return {
    duration: pcmAudio.length / (config.voiceoverSampleRateHz * 2),
    estimatedDuration: estimateVoiceDuration(cleanText),
    path: outputPath,
    text: truncateText(cleanText, 260),
    voiceName
  };
}

module.exports = {
  estimateVoiceDuration,
  synthesizeVoiceover
};
