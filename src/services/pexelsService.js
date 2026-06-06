const config = require('../config');
const { downloadFile } = require('../utils/fileCleanup');
const { normalizeWhitespace, simplifyQuery } = require('../utils/textTools');

const PEXELS_PHOTO_SEARCH = 'https://api.pexels.com/v1/search';
const PEXELS_VIDEO_SEARCH = 'https://api.pexels.com/v1/videos/search';

function pexelsHeaders() {
  return {
    Authorization: config.pexelsApiKey
  };
}

async function pexelsJson(url, options = {}) {
  if (!config.pexelsApiKey) {
    throw new Error('PEXELS_API_KEY is missing.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 20_000);

  try {
    const response = await fetch(url, {
      headers: pexelsHeaders(),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error('Media search request failed.');
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function buildUrl(baseUrl, params) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url;
}

function normalizeOrientation(orientation) {
  return orientation === 'portrait' ? 'portrait' : 'landscape';
}

function matchesOrientation(width, height, orientation) {
  return orientation === 'portrait' ? height >= width : width >= height;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  return items[randomInt(0, items.length - 1)];
}

function topRandomCandidate(scoredItems, topCount = 4) {
  const ranked = scoredItems
    .filter((item) => item.item)
    .sort((a, b) => b.score - a.score)
    .slice(0, topCount);

  return randomChoice(ranked)?.item || null;
}

function choosePhoto(photos, options = {}) {
  if (!Array.isArray(photos) || photos.length === 0) {
    return null;
  }

  const orientation = normalizeOrientation(options.orientation);
  const excludedIds = new Set((options.excludeIds || []).map(String));
  const scoredPhotos = photos.filter((photo) => !excludedIds.has(String(photo.id))).map((photo) => {
    const shapeScore = matchesOrientation(photo.width, photo.height, orientation) ? 30 : 0;
    const resolutionScore = Math.min(photo.width * photo.height, 2400 * 1600) / (2400 * 1600);

    return {
      item: photo,
      score: shapeScore + resolutionScore * 20 + Math.random() * 6
    };
  });

  const photo = topRandomCandidate(scoredPhotos);
  if (!photo) {
    return null;
  }

  return {
    id: photo.id,
    photographer: photo.photographer,
    pageUrl: photo.url,
    downloadUrl:
      photo.src?.large2x ||
      photo.src?.large ||
      photo.src?.original ||
      photo.src?.medium,
    extension: '.jpg'
  };
}

function inlinePhotoResults(photos) {
  if (!Array.isArray(photos)) {
    return [];
  }

  return photos
    .filter((photo) => photo?.src?.large || photo?.src?.medium)
    .slice(0, 8)
    .map((photo) => ({
      id: photo.id,
      photographer: photo.photographer,
      pageUrl: photo.url,
      photoUrl:
        photo.src?.large ||
        photo.src?.medium,
      thumbUrl: photo.src?.medium || photo.src?.small || photo.src?.tiny,
      width: photo.width,
      height: photo.height
    }));
}

function chooseVideoFile(video, options = {}) {
  const orientation = normalizeOrientation(options.orientation);
  const files = Array.isArray(video.video_files) ? video.video_files : [];
  const candidates = files
    .filter((file) => String(file.file_type || '').includes('mp4'))
    .filter((file) => file.link)
    .filter((file) => {
      const fileSize = Number(file.file_size || 0);
      const width = Number(file.width || 0);
      const height = Number(file.height || 0);

      if (fileSize) {
        return fileSize <= config.videoMaxBytes;
      }

      return width * height <= 1280 * 720;
    })
    .map((file) => {
      const fileSize = Number(file.file_size || 0);
      const width = Number(file.width || 0);
      const height = Number(file.height || 0);
      const shapeMatches = matchesOrientation(width, height, orientation);
      const withinSize = !fileSize || fileSize <= config.videoMaxBytes;
      const resolutionScore = Math.min(width * height, 1920 * 1080) / (1920 * 1080);
      const sizeScore = fileSize ? Math.max(0, 1 - fileSize / config.videoMaxBytes) : 0.4;
      const knownSizeScore = fileSize ? 8 : 0;

      return {
        item: file,
        score:
          (withinSize ? 20 : -100) +
          (shapeMatches ? 20 : 0) +
          resolutionScore * 25 +
          sizeScore * 15 +
          knownSizeScore +
          Math.random() * 6
      };
    })
    .sort((a, b) => b.score - a.score);

  return topRandomCandidate(candidates, 3);
}

function chooseVideo(videos, options = {}) {
  if (!Array.isArray(videos) || videos.length === 0) {
    return null;
  }

  const excludedIds = new Set((options.excludeIds || []).map(String));

  for (const video of videos) {
    if (excludedIds.has(String(video.id))) {
      continue;
    }

    const videoFile = chooseVideoFile(video, options);
    if (!videoFile) {
      continue;
    }

    return {
      id: video.id,
      pageUrl: video.url,
      duration: video.duration,
      downloadUrl: videoFile.link,
      extension: '.mp4',
      width: videoFile.width,
      height: videoFile.height,
      fileSize: videoFile.file_size
    };
  }

  return null;
}

function chooseInlineVideoFile(video) {
  const files = Array.isArray(video?.video_files) ? video.video_files : [];
  const candidates = files
    .filter((file) => String(file.file_type || '').includes('mp4'))
    .filter((file) => file.link)
    .filter((file) => {
      const width = Number(file.width || 0);
      const height = Number(file.height || 0);
      const fileSize = Number(file.file_size || 0);

      if (!width || !height || height > width) {
        return false;
      }

      if (fileSize && fileSize > 20 * 1024 * 1024) {
        return false;
      }

      return width <= 1280 && height <= 720;
    })
    .map((file) => {
      const width = Number(file.width || 0);
      const height = Number(file.height || 0);
      const fileSize = Number(file.file_size || 0);
      const ratio = width && height ? width / height : 0;
      const ratioScore = Math.max(0, 1 - Math.abs(ratio - 16 / 9));
      const sizeScore = fileSize ? Math.max(0, 1 - fileSize / (20 * 1024 * 1024)) : 0.5;
      const resolutionScore = Math.min(width * height, 1280 * 720) / (1280 * 720);

      return {
        item: file,
        score: ratioScore * 40 + resolutionScore * 25 + sizeScore * 15
      };
    })
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.item || null;
}

function inlineVideoResults(videos) {
  if (!Array.isArray(videos)) {
    return [];
  }

  return videos
    .map((video) => {
      const videoFile = chooseInlineVideoFile(video);

      if (!videoFile || !video.image) {
        return null;
      }

      return {
        id: video.id,
        pageUrl: video.url,
        thumbnailUrl: video.image,
        videoUrl: videoFile.link,
        width: videoFile.width,
        height: videoFile.height,
        duration: video.duration,
        userName: video.user?.name || ''
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

async function searchPexelsWithFallback(baseUrl, params, fallbackParams) {
  const randomUrl = buildUrl(baseUrl, params);
  const randomResult = await pexelsJson(randomUrl);

  if (fallbackParams) {
    return {
      randomResult,
      fallbackResult: async () => pexelsJson(buildUrl(baseUrl, fallbackParams))
    };
  }

  return {
    randomResult,
    fallbackResult: null
  };
}

async function searchImages(query, options = {}) {
  const cleanQuery = normalizeWhitespace(query);
  const orientation = normalizeOrientation(options.orientation);
  const randomPage = randomInt(1, 4);
  const { randomResult, fallbackResult } = await searchPexelsWithFallback(PEXELS_PHOTO_SEARCH, {
    query: cleanQuery,
    per_page: '12',
    orientation,
    page: String(randomPage)
  }, {
    query: cleanQuery,
    per_page: '12',
    orientation,
    page: '1'
  });
  const firstPhoto = choosePhoto(randomResult.photos, {
    orientation,
    excludeIds: options.excludeIds
  });

  if (firstPhoto) {
    return firstPhoto;
  }

  const pageOneResult = fallbackResult ? await fallbackResult() : null;
  const pageOnePhoto = choosePhoto(pageOneResult?.photos, {
    orientation,
    excludeIds: options.excludeIds
  });

  if (pageOnePhoto) {
    return pageOnePhoto;
  }

  const simple = simplifyQuery(cleanQuery);
  if (simple && simple !== cleanQuery) {
    const fallbackUrl = buildUrl(PEXELS_PHOTO_SEARCH, {
      query: simple,
      per_page: '12',
      orientation,
      page: String(randomInt(1, 3))
    });
    const fallbackResult = await pexelsJson(fallbackUrl);
    return choosePhoto(fallbackResult.photos, {
      orientation,
      excludeIds: options.excludeIds
    });
  }

  return null;
}

async function searchInlineImages(query, options = {}) {
  const cleanQuery = normalizeWhitespace(query);
  const orientation = normalizeOrientation(options.orientation);
  const url = buildUrl(PEXELS_PHOTO_SEARCH, {
    query: cleanQuery,
    per_page: '8',
    orientation,
    page: '1'
  });
  const result = await pexelsJson(url);
  return inlinePhotoResults(result.photos);
}

async function searchInlineVideos(query, options = {}) {
  const cleanQuery = normalizeWhitespace(query);
  const orientation = normalizeOrientation(options.orientation);
  const url = buildUrl(PEXELS_VIDEO_SEARCH, {
    query: cleanQuery,
    per_page: '10',
    orientation,
    page: '1'
  });
  const result = await pexelsJson(url, {
    timeoutMs: options.timeoutMs || 3500
  });
  return inlineVideoResults(result.videos);
}

async function searchVideos(query, options = {}) {
  const cleanQuery = normalizeWhitespace(query);
  const orientation = normalizeOrientation(options.orientation);
  const randomPage = randomInt(1, 4);
  const { randomResult, fallbackResult } = await searchPexelsWithFallback(PEXELS_VIDEO_SEARCH, {
    query: cleanQuery,
    per_page: '12',
    orientation,
    page: String(randomPage)
  }, {
    query: cleanQuery,
    per_page: '12',
    orientation,
    page: '1'
  });
  const firstVideo = chooseVideo(randomResult.videos, {
    orientation,
    excludeIds: options.excludeIds
  });

  if (firstVideo) {
    return firstVideo;
  }

  const pageOneResult = fallbackResult ? await fallbackResult() : null;
  const pageOneVideo = chooseVideo(pageOneResult?.videos, {
    orientation,
    excludeIds: options.excludeIds
  });

  if (pageOneVideo) {
    return pageOneVideo;
  }

  const simple = simplifyQuery(cleanQuery);
  if (simple && simple !== cleanQuery) {
    const fallbackUrl = buildUrl(PEXELS_VIDEO_SEARCH, {
      query: simple,
      per_page: '12',
      orientation,
      page: String(randomInt(1, 3))
    });
    const fallbackResult = await pexelsJson(fallbackUrl);
    return chooseVideo(fallbackResult.videos, {
      orientation,
      excludeIds: options.excludeIds
    });
  }

  return null;
}

async function downloadImage(photo) {
  return downloadFile(photo.downloadUrl, {
    prefix: `photo-${photo.id}`,
    extension: photo.extension || '.jpg',
    maxBytes: config.imageMaxBytes
  });
}

async function downloadVideo(video) {
  return downloadFile(video.downloadUrl, {
    prefix: `video-${video.id}`,
    extension: video.extension || '.mp4',
    maxBytes: config.videoMaxBytes
  });
}

module.exports = {
  downloadImage,
  downloadVideo,
  searchInlineImages,
  searchInlineVideos,
  searchImages,
  searchVideos
};
