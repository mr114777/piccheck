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
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', ...corsHeaders },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// --- Auth helpers ---
async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(salt + password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

function generateToken() {
  return generateId(32);
}

function generateSalt() {
  return generateId(16);
}

// Validate userId: 3-20 chars, alphanumeric + underscore
function isValidUserId(id) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(id);
}

// Get user from auth token
async function getUserFromToken(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const tokenData = await env.USERS.get(`tokens/${token}`, 'json');
  if (!tokenData) return null;
  if (new Date(tokenData.expiresAt) < new Date()) {
    await env.USERS.delete(`tokens/${token}`);
    return null;
  }
  const user = await env.USERS.get(`users/${tokenData.userId}`, 'json');
  return user;
}

// Get current month key for usage tracking
function getMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Get plan-specific limits
function getPlanLimits(plan, env) {
  switch (plan) {
    case 'pro':
      return {
        storageMB: parseInt(env.PRO_MONTHLY_STORAGE_MB || '204800'),
        maxPhotos: parseInt(env.PRO_MAX_PHOTOS || '1500'),
        ttlDays: parseInt(env.PRO_SESSION_TTL || '30'),
        maxSessions: parseInt(env.PRO_MAX_SESSIONS || '9999'),
      };
    case 'basic':
      return {
        storageMB: parseInt(env.BASIC_MONTHLY_STORAGE_MB || '10240'),
        maxPhotos: parseInt(env.BASIC_MAX_PHOTOS || '800'),
        ttlDays: parseInt(env.BASIC_SESSION_TTL || '14'),
        maxSessions: parseInt(env.BASIC_MAX_SESSIONS || '15'),
      };
    default: // free
      return {
        storageMB: parseInt(env.FREE_MONTHLY_STORAGE_MB || '5120'),
        maxPhotos: parseInt(env.FREE_MAX_PHOTOS || '300'),
        ttlDays: parseInt(env.FREE_SESSION_TTL || '7'),
        maxSessions: parseInt(env.FREE_MAX_SESSIONS || '3'),
      };
  }
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
      // =============================================
      // AUTH ENDPOINTS
      // =============================================

      // === POST /api/auth/register ===
      if (path === '/api/auth/register' && request.method === 'POST') {
        const body = await request.json();
        const { userId, password, role, displayName } = body;

        if (!userId || !password) return errorResponse('userId and password required');
        if (!isValidUserId(userId)) return errorResponse('userId must be 3-20 alphanumeric chars or underscores');
        if (password.length < 6) return errorResponse('Password must be at least 6 characters');
        if (!['photographer', 'model', 'company', 'private'].includes(role)) {
          return errorResponse('Invalid role');
        }

        // Check if userId already taken
        const existing = await env.USERS.get(`users/${userId}`);
        if (existing) return errorResponse('userId already taken', 409);

        // Hash password
        const salt = generateSalt();
        const passwordHash = await hashPassword(password, salt);

        const user = {
          id: userId,
          displayName: displayName || userId,
          role,
          salt,
          passwordHash,
          plan: 'free',
          createdAt: new Date().toISOString(),
        };

        await env.USERS.put(`users/${userId}`, JSON.stringify(user));
        await env.USERS.put(`users/${userId}/sessions`, JSON.stringify([]));
        await env.USERS.put(`users/${userId}/sent`, JSON.stringify([]));

        // Generate token
        const token = generateToken();
        const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
        await env.USERS.put(`tokens/${token}`, JSON.stringify({ userId, expiresAt }));

        const { salt: _, passwordHash: __, ...safeUser } = user;
        return jsonResponse({ token, expiresAt, user: safeUser }, 201);
      }

      // === POST /api/auth/login ===
      if (path === '/api/auth/login' && request.method === 'POST') {
        // Rate limiting: 5 attempts per IP per 5 minutes
        const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rateLimitKey = `ratelimit/login/${clientIP}`;
        const attempts = await env.USERS.get(rateLimitKey, 'json') || { count: 0, resetAt: 0 };
        const now = Date.now();
        if (now < attempts.resetAt && attempts.count >= 5) {
          const waitSec = Math.ceil((attempts.resetAt - now) / 1000);
          return errorResponse(`ログイン試行回数を超えました。${waitSec}秒後にお試しください`, 429);
        }
        if (now >= attempts.resetAt) {
          attempts.count = 0;
          attempts.resetAt = now + 300000; // 5 minutes
        }
        attempts.count++;
        await env.USERS.put(rateLimitKey, JSON.stringify(attempts), { expirationTtl: 300 });

        const body = await request.json();
        const { userId, password } = body;

        if (!userId || !password) return errorResponse('userId and password required');

        const user = await env.USERS.get(`users/${userId}`, 'json');
        if (!user) return errorResponse('Invalid credentials', 401);

        const hash = await hashPassword(password, user.salt);
        if (hash !== user.passwordHash) return errorResponse('Invalid credentials', 401);

        // Generate token
        const token = generateToken();
        const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
        await env.USERS.put(`tokens/${token}`, JSON.stringify({ userId, expiresAt }));

        const { salt, passwordHash, ...safeUser } = user;
        return jsonResponse({ token, expiresAt, user: safeUser });
      }

      // === GET /api/auth/me ===
      if (path === '/api/auth/me' && request.method === 'GET') {
        const user = await getUserFromToken(request, env);
        if (!user) return errorResponse('Unauthorized', 401);

        const { salt, passwordHash, ...safeUser } = user;

        // Include usage info
        const monthKey = getMonthKey();
        const usage = await env.USERS.get(`users/${user.id}/usage/${monthKey}`, 'json') || { uploadedBytes: 0 };
        const limits = getPlanLimits(user.plan, env);
        const sessionCount = await env.USERS.get(`users/${user.id}/sessions-count/${monthKey}`, 'json') || { count: 0 };

        return jsonResponse({
          user: safeUser,
          usage: {
            usedMB: Math.round(usage.uploadedBytes / 1048576),
            limitMB: limits.storageMB,
            remainingMB: Math.max(0, limits.storageMB - Math.round(usage.uploadedBytes / 1048576)),
          },
          sessions: {
            used: sessionCount.count,
            limit: limits.maxSessions,
            remaining: Math.max(0, limits.maxSessions - sessionCount.count),
          },
          planLimits: {
            maxPhotos: limits.maxPhotos,
            ttlDays: limits.ttlDays,
            maxSessions: limits.maxSessions,
            storageMB: limits.storageMB,
          },
        });
      }

      // === GET /api/user/:userId ===
      const userMatch = path.match(/^\/api\/user\/([a-zA-Z0-9_]+)$/);
      if (userMatch && request.method === 'GET') {
        const userId = userMatch[1];
        const user = await env.USERS.get(`users/${userId}`, 'json');
        if (!user) return errorResponse('User not found', 404);

        return jsonResponse({
          id: user.id,
          displayName: user.displayName,
          role: user.role,
          plan: user.plan,
          createdAt: user.createdAt,
        });
      }

      // === GET /api/user/search?q=xxx ===
      if (path === '/api/user/search' && request.method === 'GET') {
        const q = url.searchParams.get('q');
        if (!q || q.length < 2) return errorResponse('Query must be at least 2 characters');

        // KV doesn't support prefix search natively, so we try exact match
        const user = await env.USERS.get(`users/${q}`, 'json');
        if (!user) return jsonResponse({ results: [] });

        return jsonResponse({
          results: [{
            id: user.id,
            displayName: user.displayName,
            role: user.role,
          }],
        });
      }

      // === GET /api/user/:userId/projects ===
      const projectsMatch = path.match(/^\/api\/user\/([a-zA-Z0-9_]+)\/projects$/);
      if (projectsMatch && request.method === 'GET') {
        const authedUser = await getUserFromToken(request, env);
        if (!authedUser || authedUser.id !== projectsMatch[1]) {
          return errorResponse('Unauthorized', 401);
        }

        const sessions = await env.USERS.get(`users/${authedUser.id}/sessions`, 'json') || [];
        const sent = await env.USERS.get(`users/${authedUser.id}/sent`, 'json') || [];

        return jsonResponse({ received: sessions, sent });
      }

      // === POST /api/user/:userId/link-session ===
      const linkMatch = path.match(/^\/api\/user\/([a-zA-Z0-9_]+)\/link-session$/);
      if (linkMatch && request.method === 'POST') {
        // Require authentication
        const authedUser = await getUserFromToken(request, env);
        if (!authedUser) return errorResponse('Unauthorized', 401);

        const targetUserId = linkMatch[1];
        const body = await request.json();
        const { sessionId, direction } = body; // direction: 'received' or 'sent'

        // Only allow linking to your own account or if you are the sender
        if (direction === 'sent' && authedUser.id !== targetUserId) {
          return errorResponse('Can only link sent sessions to your own account', 403);
        }

        const targetUser = await env.USERS.get(`users/${targetUserId}`, 'json');
        if (!targetUser) return errorResponse('User not found', 404);

        const key = direction === 'sent' ? `users/${targetUserId}/sent` : `users/${targetUserId}/sessions`;
        const list = await env.USERS.get(key, 'json') || [];

        if (!list.includes(sessionId)) {
          list.push(sessionId);
          await env.USERS.put(key, JSON.stringify(list));
        }

        return jsonResponse({ ok: true });
      }

      // =============================================
      // SESSION ENDPOINTS (existing)
      // =============================================

      // === POST /api/session — Create new session ===
      if (path === '/api/session' && request.method === 'POST') {
        const body = await request.json();
        const sessionId = generateId(8);
        const now = new Date().toISOString();

        // Get plan limits (use creator's plan if authenticated)
        let creatorPlan = 'free';
        const creator = await getUserFromToken(request, env);
        if (creator) creatorPlan = creator.plan || 'free';
        const limits = getPlanLimits(creatorPlan, env);

        // Check monthly session limit
        if (creator) {
          const monthKey = getMonthKey();
          const sessionCountKey = `users/${creator.id}/sessions-count/${monthKey}`;
          const count = await env.USERS.get(sessionCountKey, 'json') || { count: 0 };
          if (count.count >= limits.maxSessions) {
            return errorResponse(`Monthly session limit reached (${limits.maxSessions} sessions). Please upgrade your plan.`, 429);
          }
          count.count++;
          await env.USERS.put(sessionCountKey, JSON.stringify(count), { expirationTtl: 86400 * 35 });
        }

        const expiresAt = new Date(Date.now() + limits.ttlDays * 86400000).toISOString();

        const meta = {
          id: sessionId,
          title: body.title || '',
          photographer: body.photographer || '',
          recipient: body.recipient || '',
          creatorId: creator ? creator.id : (body.creatorId || ''),
          notifyEmail: body.notifyEmail || '',
          groups: body.groups || [],
          createdAt: now,
          expiresAt,
          photoCount: 0,
          photos: [],
          selectionsOk: 0,
          selectionsNg: 0,
          isCompleted: false,
          plan: creatorPlan,
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

      // === PATCH /api/session/:id — Update session metadata ===
      if (sessionMatch && request.method === 'PATCH') {
        const sessionId = sessionMatch[1];
        const metaKey = `sessions/${sessionId}/meta.json`;
        const obj = await env.PHOTOS.get(metaKey);
        if (!obj) return errorResponse('Session not found', 404);

        const meta = JSON.parse(await obj.text());
        const updates = await request.json();

        // Allow updating title, photographer, limits
        if ('title' in updates) meta.title = updates.title;
        if ('photographer' in updates) meta.photographer = updates.photographer;
        if ('limits' in updates && meta.groups) {
          // Update group limits
          for (const [gid, limit] of Object.entries(updates.limits)) {
            const g = meta.groups.find(g => g.id === gid);
            if (g) g.limit = parseInt(limit) || 0;
          }
        }

        await env.PHOTOS.put(metaKey, JSON.stringify(meta), {
          httpMetadata: { contentType: 'application/json' },
        });

        return jsonResponse({ ok: true });
      }

      // === POST /api/session/:id/upload — Upload a photo ===
      const uploadMatch = path.match(/^\/api\/session\/([a-zA-Z0-9]+)\/upload$/);
      if (uploadMatch && request.method === 'POST') {
        const sessionId = uploadMatch[1];

        // Get session meta
        const metaObj = await env.PHOTOS.get(`sessions/${sessionId}/meta.json`);
        if (!metaObj) return errorResponse('Session not found', 404);
        const meta = JSON.parse(await metaObj.text());

        // Check photo limit (use session's plan)
        const planLimits = getPlanLimits(meta.plan || 'free', env);
        if (meta.photoCount >= planLimits.maxPhotos) {
          return errorResponse(`Maximum ${planLimits.maxPhotos} photos per session`, 429);
        }

        // Parse multipart form
        const formData = await request.formData();
        const file = formData.get('file');
        const fname = formData.get('fname') || file.name;
        const groupId = formData.get('groupId') || '';
        const thumbData = formData.get('thumb'); // base64 or blob

        if (!file) return errorResponse('No file provided');

        // Check file size
        const maxSize = parseInt(env.MAX_FILE_SIZE_MB || '30') * 1024 * 1024;
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

      // === DELETE /api/session/:id/photos — Delete photos ===
      const deletePhotosMatch = path.match(/^\/api\/session\/([a-zA-Z0-9]+)\/photos$/);
      if (deletePhotosMatch && request.method === 'DELETE') {
        const [, sessionId] = deletePhotosMatch;
        const metaKey = `sessions/${sessionId}/meta.json`;
        const metaObj = await env.PHOTOS.get(metaKey);
        if (!metaObj) return errorResponse('Session not found', 404);

        const meta = await metaObj.json();
        const { fnames } = await request.json();
        if (!fnames || !Array.isArray(fnames)) {
          return errorResponse('fnames array required', 400);
        }

        let deleted = 0;
        for (const fname of fnames) {
          // Delete photo from R2
          try { await env.PHOTOS.delete(`sessions/${sessionId}/photos/${fname}`); } catch (e) { }
          // Delete thumbnail from R2
          try { await env.PHOTOS.delete(`sessions/${sessionId}/thumbs/${fname}`); } catch (e) { }
          // Remove from meta
          const idx = meta.photos.findIndex(p => p.fname === fname);
          if (idx !== -1) {
            meta.photos.splice(idx, 1);
            meta.photoCount = Math.max(0, (meta.photoCount || 0) - 1);
            deleted++;
          }
        }

        // Save updated meta
        await env.PHOTOS.put(metaKey, JSON.stringify(meta), {
          httpMetadata: { contentType: 'application/json' },
        });

        return jsonResponse({ ok: true, deleted });
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

      // === POST /api/session/:id/selections — Save selection results ===
      const selPostMatch = path.match(/^\/api\/session\/([a-zA-Z0-9]+)\/selections$/);
      if (selPostMatch && request.method === 'POST') {
        const sessionId = selPostMatch[1];
        const metaKey = `sessions/${sessionId}/meta.json`;
        const metaObj = await env.PHOTOS.get(metaKey);
        if (!metaObj) return errorResponse('Session not found', 404);

        const meta = JSON.parse(await metaObj.text());
        if (new Date(meta.expiresAt) < new Date()) {
          return errorResponse('Session expired', 410);
        }

        const body = await request.json();
        const { selections, completedAt } = body;
        // selections = { "photo1.jpg": "ok", "photo2.jpg": "ng", ... }

        if (!selections || typeof selections !== 'object') {
          return errorResponse('selections object required');
        }

        // Save selections to R2
        await env.PHOTOS.put(
          `sessions/${sessionId}/selections.json`,
          JSON.stringify({ selections, completedAt: completedAt || new Date().toISOString(), savedAt: new Date().toISOString() }),
          { httpMetadata: { contentType: 'application/json' } }
        );

        // Update meta with counts
        let okCount = 0, ngCount = 0;
        for (const [, status] of Object.entries(selections)) {
          if (status === 'ok') okCount++;
          else if (status === 'ng') ngCount++;
        }
        meta.selectionsOk = okCount;
        meta.selectionsNg = ngCount;
        meta.isCompleted = !!completedAt;
        meta.completedAt = completedAt || null;

        await env.PHOTOS.put(metaKey, JSON.stringify(meta), {
          httpMetadata: { contentType: 'application/json' },
        });

        return jsonResponse({ ok: true, selectionsOk: okCount, selectionsNg: ngCount, isCompleted: meta.isCompleted });
      }

      // === GET /api/session/:id/selections — Get selection results ===
      if (selPostMatch && request.method === 'GET') {
        const sessionId = selPostMatch[1];
        const obj = await env.PHOTOS.get(`sessions/${sessionId}/selections.json`);
        if (!obj) return jsonResponse({ selections: {}, completedAt: null });

        const data = JSON.parse(await obj.text());
        return jsonResponse(data);
      }

      // === 404 ===
      return errorResponse('Not found', 404);

    } catch (err) {
      console.error('Worker error:', err);
      return errorResponse('Internal server error: ' + err.message, 500);
    }
  },
};
