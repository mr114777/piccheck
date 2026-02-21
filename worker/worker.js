/**
 * SELEKT API - Cloudflare Worker
 * Photo session sharing via R2
 */

// Simple nanoid-like ID generator
function generateId(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let id = '';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) {
    id += chars[arr[i] % chars.length];
  }
  return id;
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // === POST /api/session — Create new session ===
      if (path === '/api/session' && request.method === 'POST') {
        const body = await request.json();
        const sessionId = generateId(8);
        const now = new Date().toISOString();
        const ttlDays = parseInt(env.SESSION_TTL_DAYS || '7');
        const expiresAt = new Date(Date.now() + ttlDays * 86400000).toISOString();

        const meta = {
          id: sessionId,
          title: body.title || '',
          photographer: body.photographer || '',
          groups: body.groups || [],
          createdAt: now,
          expiresAt,
          photoCount: 0,
          photos: [],
        };

        await env.PHOTOS.put(
          `sessions/${sessionId}/meta.json`,
          JSON.stringify(meta),
          { httpMetadata: { contentType: 'application/json' } }
        );

        return jsonResponse({ sessionId, expiresAt });
      }

      // === GET /api/session/:id — Get session info ===
      const sessionMatch = path.match(/^\/api\/session\/([a-zA-Z0-9]+)$/);
      if (sessionMatch && request.method === 'GET') {
        const sessionId = sessionMatch[1];
        const obj = await env.PHOTOS.get(`sessions/${sessionId}/meta.json`);
        if (!obj) return errorResponse('Session not found', 404);

        const meta = JSON.parse(await obj.text());

        // Check expiry
        if (new Date(meta.expiresAt) < new Date()) {
          return errorResponse('Session expired', 410);
        }

        return jsonResponse(meta);
      }

      // === POST /api/session/:id/upload — Upload a photo ===
      const uploadMatch = path.match(/^\/api\/session\/([a-zA-Z0-9]+)\/upload$/);
      if (uploadMatch && request.method === 'POST') {
        const sessionId = uploadMatch[1];

        // Get session meta
        const metaObj = await env.PHOTOS.get(`sessions/${sessionId}/meta.json`);
        if (!metaObj) return errorResponse('Session not found', 404);
        const meta = JSON.parse(await metaObj.text());

        // Check photo limit
        const maxPhotos = parseInt(env.MAX_PHOTOS_PER_SESSION || '50');
        if (meta.photoCount >= maxPhotos) {
          return errorResponse(`Maximum ${maxPhotos} photos per session`, 429);
        }

        // Parse multipart form
        const formData = await request.formData();
        const file = formData.get('file');
        const fname = formData.get('fname') || file.name;
        const groupId = formData.get('groupId') || '';
        const thumbData = formData.get('thumb'); // base64 or blob

        if (!file) return errorResponse('No file provided');

        // Check file size
        const maxSize = parseInt(env.MAX_FILE_SIZE_MB || '25') * 1024 * 1024;
        if (file.size > maxSize) {
          return errorResponse(`File too large (max ${env.MAX_FILE_SIZE_MB}MB)`);
        }

        // Save original photo to R2
        await env.PHOTOS.put(
          `sessions/${sessionId}/photos/${fname}`,
          file.stream(),
          {
            httpMetadata: { contentType: file.type || 'image/jpeg' },
            customMetadata: { groupId, originalName: fname },
          }
        );

        // Save thumbnail if provided
        if (thumbData) {
          let thumbBody;
          if (typeof thumbData === 'string') {
            // base64 data URL
            const base64 = thumbData.replace(/^data:image\/\w+;base64,/, '');
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            thumbBody = bytes;
          } else {
            thumbBody = thumbData.stream();
          }
          await env.PHOTOS.put(
            `sessions/${sessionId}/thumbs/${fname}`,
            thumbBody,
            { httpMetadata: { contentType: 'image/jpeg' } }
          );
        }

        // Update meta
        meta.photoCount++;
        meta.photos.push({
          fname,
          groupId,
          size: file.size,
          type: file.type,
        });

        await env.PHOTOS.put(
          `sessions/${sessionId}/meta.json`,
          JSON.stringify(meta),
          { httpMetadata: { contentType: 'application/json' } }
        );

        return jsonResponse({
          ok: true,
          fname,
          photoCount: meta.photoCount,
        });
      }

      // === GET /api/session/:id/photo/:fname — Get full photo ===
      const photoMatch = path.match(/^\/api\/session\/([a-zA-Z0-9]+)\/photo\/(.+)$/);
      if (photoMatch && request.method === 'GET') {
        const [, sessionId, fname] = photoMatch;
        const key = `sessions/${sessionId}/photos/${decodeURIComponent(fname)}`;
        const obj = await env.PHOTOS.get(key);
        if (!obj) return errorResponse('Photo not found', 404);

        return new Response(obj.body, {
          headers: {
            'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
            'Cache-Control': 'public, max-age=86400',
            ...corsHeaders,
          },
        });
      }

      // === GET /api/session/:id/thumb/:fname — Get thumbnail ===
      const thumbMatch = path.match(/^\/api\/session\/([a-zA-Z0-9]+)\/thumb\/(.+)$/);
      if (thumbMatch && request.method === 'GET') {
        const [, sessionId, fname] = thumbMatch;
        const key = `sessions/${sessionId}/thumbs/${decodeURIComponent(fname)}`;
        const obj = await env.PHOTOS.get(key);

        if (!obj) {
          // Fallback to full photo if no thumb
          const fullKey = `sessions/${sessionId}/photos/${decodeURIComponent(fname)}`;
          const fullObj = await env.PHOTOS.get(fullKey);
          if (!fullObj) return errorResponse('Photo not found', 404);
          return new Response(fullObj.body, {
            headers: {
              'Content-Type': fullObj.httpMetadata?.contentType || 'image/jpeg',
              'Cache-Control': 'public, max-age=86400',
              ...corsHeaders,
            },
          });
        }

        return new Response(obj.body, {
          headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=86400',
            ...corsHeaders,
          },
        });
      }

      // === 404 ===
      return errorResponse('Not found', 404);

    } catch (err) {
      console.error('Worker error:', err);
      return errorResponse('Internal server error: ' + err.message, 500);
    }
  },
};
