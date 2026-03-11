// ============================
// SELEKT — Supabase Configuration
// ============================
// This file initializes the Supabase client for use across all SELEKT pages.
// Include this file AFTER the Supabase JS CDN script tag.

const SUPABASE_URL = 'https://hbbnrkqxlstbpxbeeeki.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_EdypgcpRTPmPMi6GmUKnPA_2gJ8cl9Q';

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
 * Sign out
 */
async function signOut() {
    const { error } = await _sb.auth.signOut();
    if (!error) {
        window.location.href = 'SELEKT_Login.html';
    }
    return { error };
}

/**
 * Require auth — redirect to login if not logged in.
 * Call this at the top of protected pages.
 */
async function requireAuth() {
    const user = await getCurrentUser();
    if (!user) {
        window.location.href = 'SELEKT_Login.html';
        return null;
    }
    return user;
}

/**
 * Listen for auth state changes
 */
function onAuthStateChange(callback) {
    _sb.auth.onAuthStateChange((event, session) => {
        callback(event, session);
    });
}
