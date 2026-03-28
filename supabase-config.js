// ============================
// SELEKT — Supabase Configuration
// ============================
// This file initializes the Supabase client for use across all SELEKT pages.
// Include this file AFTER the Supabase JS CDN script tag.

// TODO: Replace with valid Supabase credentials
const SUPABASE_URL = 'https://hbbnrkqxlstbpxbeeeki.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_EdypgcpRTPmPMi6GmUKnPA_2gJ8cl9Q';

const SELEKT_API = 'https://selekt-api.mr-mail114.workers.dev';

// Initialize the Supabase client (use _sb to avoid conflict with the CDN global 'supabase')
const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===== AUTH HELPERS =====

/**
 * Get current logged-in user. Returns null if not logged in.
 */
async function getCurrentUser() {
    const { data: { user } } = await _sb.auth.getUser();
    return user;
}

/**
 * Get current session. Returns null if no active session.
 */
async function getSession() {
    const { data: { session } } = await _sb.auth.getSession();
    return session;
}

/**
 * Sign up with email and password
 */
async function signUpWithEmail(email, password, displayName) {
    const { data, error } = await _sb.auth.signUp({
        email,
        password,
        options: {
            data: { display_name: displayName }
        }
    });
    return { data, error };
}

/**
 * Sign in with email and password
 */
async function signInWithEmail(email, password) {
    const { data, error } = await _sb.auth.signInWithPassword({
        email,
        password
    });
    return { data, error };
}

/**
 * Sign in with Google OAuth
 */
async function signInWithGoogle() {
    const { data, error } = await _sb.auth.signInWithOAuth({
        provider: 'google',
        options: {
            redirectTo: window.location.origin + '/SELEKT_Dashboard.html'
        }
    });
    return { data, error };
}

/**
 * Sign out — clears both Supabase session and custom API token
 */
async function signOut() {
    localStorage.removeItem('selekt_token');
    localStorage.removeItem('selekt_user');
    localStorage.removeItem('selekt_my_sessions');
    localStorage.removeItem('selekt_avatar_photo');
    localStorage.removeItem('selekt_cover_photo');
    const { error } = await _sb.auth.signOut();
    window.location.href = 'SELEKT_Auth.html';
    return { error };
}

/**
 * Require auth — redirect to login if not logged in.
 * Call this at the top of protected pages.
 * Returns the Supabase user if available, otherwise checks custom token.
 */
async function requireAuth() {
    // Try Supabase first
    const user = await getCurrentUser();
    if (user) {
        await ensureApiToken(user);
        return user;
    }
    // Fallback: check if custom token is still valid
    const token = localStorage.getItem('selekt_token');
    if (token) {
        try {
            const res = await fetch(SELEKT_API + '/api/auth/me', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            if (res.ok) return (await res.json()).user;
        } catch (e) { /* ignore */ }
    }
    window.location.href = 'SELEKT_Auth.html';
    return null;
}

/**
 * Bridge: ensure the user has a custom API token after Supabase login.
 * Auto-registers on the custom API if needed using the Supabase user ID.
 */
async function ensureApiToken(supabaseUser) {
    const existing = localStorage.getItem('selekt_token');
    if (existing) {
        try {
            const res = await fetch(SELEKT_API + '/api/auth/me', {
                headers: { 'Authorization': 'Bearer ' + existing }
            });
            if (res.ok) return existing;
        } catch (e) { /* token invalid, continue */ }
    }

    // Derive a userId from Supabase user
    const userId = (supabaseUser.user_metadata?.display_name || supabaseUser.email?.split('@')[0] || 'user')
        .replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 20) || 'user';
    const tempPassword = 'sb_' + supabaseUser.id.slice(0, 24);

    // Try login first
    try {
        const loginRes = await fetch(SELEKT_API + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, password: tempPassword }),
        });
        if (loginRes.ok) {
            const data = await loginRes.json();
            localStorage.setItem('selekt_token', data.token);
            localStorage.setItem('selekt_user', JSON.stringify(data.user));
            return data.token;
        }
    } catch (e) { /* try register */ }

    // Register
    try {
        const regRes = await fetch(SELEKT_API + '/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId,
                password: tempPassword,
                role: 'photographer',
                displayName: supabaseUser.user_metadata?.display_name || userId,
            }),
        });
        if (regRes.ok) {
            const data = await regRes.json();
            localStorage.setItem('selekt_token', data.token);
            localStorage.setItem('selekt_user', JSON.stringify(data.user));
            return data.token;
        }
    } catch (e) { /* bridge failed */ }

    return null;
}

/**
 * Get API auth header for use with custom worker.js endpoints
 */
function getApiAuthHeader() {
    const token = localStorage.getItem('selekt_token');
    return token ? { 'Authorization': 'Bearer ' + token } : {};
}

/**
 * Listen for auth state changes
 */
function onAuthStateChange(callback) {
    _sb.auth.onAuthStateChange((event, session) => {
        callback(event, session);
    });
}
